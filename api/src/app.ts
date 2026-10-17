import Fastify, { type FastifyRequest } from 'fastify';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import { verifyToken, signToken } from './auth.js';
import { withTenant, type Db } from './db.js';
import { ApiError, fromPg } from './errors.js';
import { resources, columnsOf, isSystemCol, alwaysVisible, type Resource } from './resources.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = (c: string) => `"${c}"`; // column names only ever come from the schema whitelist

type Access = Record<string, 'none' | 'read' | 'edit'>;

export function buildApp(opts: {
  jwtSecret: string; logger?: boolean; uiDir?: string; trustProxy?: boolean;
  sandboxLogin?: { key: string; tenantId: string };
}) {
  const app = Fastify({ logger: opts.logger ?? false, genReqId: () => randomUUID(), trustProxy: opts.trustProxy ?? false });

  app.setErrorHandler((err: any, req, reply) => {
    const mapped = err instanceof ApiError ? err : fromPg(err);
    if (mapped) {
      return reply.status(mapped.status).send({ error: { code: mapped.code, message: mapped.message, details: mapped.details } });
    }
    if (err.validation || err.statusCode === 400) {
      return reply.status(400).send({ error: { code: 'bad_request', message: err.message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  // Runs fn inside one tenant scoped transaction for the caller named in the token.
  async function authed<T>(req: FastifyRequest, fn: (db: Db, userId: string) => Promise<T>): Promise<T> {
    const id = verifyToken(opts.jwtSecret, req.headers.authorization);
    return withTenant({ tenantId: id.tenantId, userId: id.userId, requestId: req.id }, async (db) => {
      const u = await db.query(`SELECT status FROM app_user WHERE id = $1 AND deleted_at IS NULL`, [id.userId]);
      if (u.rowCount === 0 || u.rows[0].status === 'disabled') throw new ApiError(401, 'unauthenticated', 'User not found or disabled');
      return fn(db, id.userId);
    });
  }

  async function can(db: Db, userId: string, perm: string, action: 'read' | 'create' | 'edit' | 'delete') {
    const r = await db.query(`SELECT can_do($1::uuid, $2, $3) AS ok`, [userId, perm, action]);
    if (!r.rows[0].ok) throw new ApiError(403, 'forbidden', `You cannot ${action} ${perm}`);
  }

  async function accessMap(db: Db, userId: string, res: Resource, cols: string[]): Promise<Access> {
    const r = await db.query(
      `SELECT c AS col, field_access($1::uuid, $2, c) AS access FROM unnest($3::text[]) AS c`,
      [userId, res.perm, cols],
    );
    const m: Access = {};
    for (const row of r.rows) m[row.col] = row.access;
    return m;
  }

  const visible = (row: Record<string, unknown>, acc: Access) =>
    Object.fromEntries(Object.entries(row).filter(([c]) => alwaysVisible.includes(c) || (c !== 'tenant_id' && acc[c] !== 'none')));

  // Checks a request body against the schema, the read only list and the caller's field access.
  function checkBody(body: any, res: Resource, cols: string[], acc: Access, mode: 'create' | 'update') {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'bad_request', 'Body must be a JSON object');
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (mode === 'update' && k === 'version') continue;
      if (!cols.includes(k)) throw new ApiError(400, 'unknown_field', `Unknown field: ${k}`);
      if (isSystemCol(k) || res.readOnlyCols.includes(k)) throw new ApiError(400, 'read_only_field', `${k} is set by the system`);
      const level = acc[k] ?? 'none';
      if (mode === 'update' ? level !== 'edit' : level === 'none') throw new ApiError(403, 'field_forbidden', `You cannot ${mode === 'update' ? 'edit' : 'set'} ${k}`);
      out[k] = v;
    }
    return out;
  }

  if (opts.uiDir) {
    app.register(fastifyStatic, { root: opts.uiDir, prefix: '/', cacheControl: true, maxAge: '5m' });
  }

  app.get('/health', async () => ({ ok: true }));

  // Sandbox login: email plus one long key set on the server. Limited to 10 tries per 15 minutes per address.
  const tries = new Map<string, { n: number; reset: number }>();
  const digest = (x: string) => createHash('sha256').update(x).digest();
  app.post('/v1/login', async (req, reply) => {
    const cfg = opts.sandboxLogin;
    if (!cfg) throw new ApiError(404, 'not_found', 'Not found');
    const now = Date.now();
    const t = tries.get(req.ip);
    if (t && t.reset > now && t.n >= 10) throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Wait 15 minutes and try again.');
    const body: any = req.body ?? {};
    const keyOk = typeof body.key === 'string' && timingSafeEqual(digest(body.key), digest(cfg.key));
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const user = keyOk && email
      ? await withTenant({ tenantId: cfg.tenantId, userId: '00000000-0000-0000-0000-000000000000', actorType: 'system', requestId: req.id }, async (db) =>
          (await db.query(`SELECT id FROM app_user WHERE email = $1 AND deleted_at IS NULL AND status <> 'disabled'`, [email])).rows[0])
      : undefined;
    if (!user) {
      tries.set(req.ip, { n: (t && t.reset > now ? t.n : 0) + 1, reset: t && t.reset > now ? t.reset : now + 15 * 60_000 });
      throw new ApiError(401, 'unauthenticated', 'Wrong email or key');
    }
    tries.delete(req.ip);
    return reply.send({ token: signToken(opts.jwtSecret, { tenantId: cfg.tenantId, userId: user.id }, 12 * 3600) });
  });

  // Names for owner pickers. Any signed in user may see who is in their own tenant.
  app.get('/v1/users', async (req) =>
    authed(req, async (db) => {
      const r = await db.query(
        `SELECT id, email, display_name, status FROM app_user WHERE deleted_at IS NULL AND status <> 'disabled' ORDER BY display_name`);
      return { data: r.rows };
    }));

  app.get('/v1/me', async (req) =>
    authed(req, async (db, userId) => {
      const u = await db.query(`SELECT id, email, display_name, status FROM app_user WHERE id = $1`, [userId]);
      const permissions: Record<string, string[]> = {};
      for (const r of resources) {
        const p = await db.query(
          `SELECT a FROM unnest(ARRAY['read','create','edit','delete']) a WHERE can_do($1::uuid, $2, a)`, [userId, r.perm]);
        permissions[r.perm] = p.rows.map((x) => x.a);
      }
      return { user: u.rows[0], permissions };
    }));

  for (const res of resources) {
    const base = `/v1/${res.path}`;

    app.get(base, async (req) =>
      authed(req, async (db, userId) => {
        await can(db, userId, res.perm, 'read');
        const cols = await columnsOf(db, res.table);
        const acc = await accessMap(db, userId, res, cols);
        const qs = req.query as Record<string, string>;
        const limit = Math.min(Math.max(parseInt(qs.limit ?? '50', 10) || 50, 1), 200);
        const where: string[] = [];
        const args: unknown[] = [];
        if (cols.includes('deleted_at') && qs.include_deleted !== 'true') where.push('deleted_at IS NULL');
        for (const [k, v] of Object.entries(qs)) {
          if (['limit', 'after', 'include_deleted'].includes(k)) continue;
          if (!cols.includes(k)) throw new ApiError(400, 'unknown_filter', `Cannot filter on ${k}`);
          if (acc[k] === 'none' && !alwaysVisible.includes(k)) throw new ApiError(403, 'field_forbidden', `You cannot filter on ${k}`);
          args.push(v);
          where.push(`${q(k)}::text = $${args.length}`);
        }
        if (qs.after) {
          if (!UUID.test(qs.after)) throw new ApiError(400, 'bad_request', 'after must be an id');
          args.push(qs.after);
          where.push(`id > $${args.length}`);
        }
        args.push(limit + 1);
        const sql = `SELECT * FROM ${q(res.table)} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id LIMIT $${args.length}`;
        const r = await db.query(sql, args);
        const page = r.rows.slice(0, limit);
        return {
          data: page.map((row) => visible(row, acc)),
          next: r.rows.length > limit ? page[page.length - 1].id : null,
        };
      }));

    app.get(`${base}/:id`, async (req) =>
      authed(req, async (db, userId) => {
        const { id } = req.params as { id: string };
        if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Not found');
        await can(db, userId, res.perm, 'read');
        const cols = await columnsOf(db, res.table);
        const acc = await accessMap(db, userId, res, cols);
        const r = await db.query(`SELECT * FROM ${q(res.table)} WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (r.rowCount === 0) throw new ApiError(404, 'not_found', 'Not found');
        return visible(r.rows[0], acc);
      }));

    if (!res.writable) continue;

    app.post(base, async (req, reply) => {
      const row = await authed(req, async (db, userId) => {
        await can(db, userId, res.perm, 'create');
        const cols = await columnsOf(db, res.table);
        const acc = await accessMap(db, userId, res, cols);
        const fields = checkBody(req.body, res, cols, acc, 'create');
        if (res.defaultOwner && fields.owner_user_id === undefined) fields.owner_user_id = userId;
        const keys = Object.keys(fields);
        const tenantId = (await db.query(`SELECT current_tenant_id() AS t`)).rows[0].t;
        const names = ['tenant_id', ...keys].map(q).join(', ');
        const marks = ['$1', ...keys.map((_, i) => `$${i + 2}`)].join(', ');
        const r = await db.query(`INSERT INTO ${q(res.table)} (${names}) VALUES (${marks}) RETURNING *`, [tenantId, ...keys.map((k) => fields[k])]);
        return visible(r.rows[0], acc);
      });
      return reply.status(201).send(row);
    });

    app.patch(`${base}/:id`, async (req) =>
      authed(req, async (db, userId) => {
        const { id } = req.params as { id: string };
        if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Not found');
        await can(db, userId, res.perm, 'edit');
        const cols = await columnsOf(db, res.table);
        const acc = await accessMap(db, userId, res, cols);
        const body: any = req.body;
        if (!Number.isInteger(body?.version)) throw new ApiError(400, 'version_required', 'Send the version you last read, so edits never overwrite each other');
        const fields = checkBody(body, res, cols, acc, 'update');
        const keys = Object.keys(fields);
        if (keys.length === 0) throw new ApiError(400, 'bad_request', 'No fields to change');
        const sets = keys.map((k, i) => `${q(k)} = $${i + 3}`).join(', ');
        const r = await db.query(
          `UPDATE ${q(res.table)} SET ${sets} WHERE id = $1 AND version = $2 AND deleted_at IS NULL RETURNING *`,
          [id, body.version, ...keys.map((k) => fields[k])],
        );
        if (r.rowCount === 0) {
          const exists = await db.query(`SELECT version FROM ${q(res.table)} WHERE id = $1 AND deleted_at IS NULL`, [id]);
          if (exists.rowCount === 0) throw new ApiError(404, 'not_found', 'Not found');
          throw new ApiError(409, 'version_conflict', 'Someone else changed this record. Reload and try again', { current_version: exists.rows[0].version });
        }
        return visible(r.rows[0], acc);
      }));

    // Soft delete only. The database role cannot hard delete.
    app.delete(`${base}/:id`, async (req, reply) => {
      await authed(req, async (db, userId) => {
        const { id } = req.params as { id: string };
        if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Not found');
        await can(db, userId, res.perm, 'delete');
        const r = await db.query(`UPDATE ${q(res.table)} SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (r.rowCount === 0) throw new ApiError(404, 'not_found', 'Not found');
      });
      return reply.status(204).send();
    });
  }

  return app;
}
