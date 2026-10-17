import type { FastifyInstance } from 'fastify';
import { type Kit, UUID } from './kit.js';
import { ApiError } from './errors.js';

const PERM: Record<string, string> = { accounts: 'account', contacts: 'contact', deals: 'opportunity', cases: 'case' };
const OPS = ['contains', 'is', 'is_not', 'empty', 'not_empty', 'gt', 'lt', 'before', 'after', 'next_days', 'past_days'];

// A filter is { search: "words", conditions: [{ field, op, value }] }. The screens apply it to the list they already loaded.
function cleanFilter(raw: unknown) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'bad_request', 'filter must be an object');
  const f = raw as any;
  const search = f.search === undefined || f.search === null ? '' : String(f.search).trim().slice(0, 80);
  const list = f.conditions === undefined ? [] : f.conditions;
  if (!Array.isArray(list) || list.length > 10) throw new ApiError(400, 'bad_request', 'Use up to 10 conditions');
  const conditions = list.map((c: any, i: number) => {
    if (!c || typeof c.field !== 'string' || !/^[a-z0-9_.]{1,60}$/.test(c.field)) throw new ApiError(400, 'bad_request', `Condition ${i + 1} needs a field`);
    if (!OPS.includes(c.op)) throw new ApiError(400, 'bad_request', `Condition ${i + 1} has an unknown test`);
    const v = c.value ?? null;
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) throw new ApiError(400, 'bad_request', `Condition ${i + 1} has a bad value`);
    if (typeof v === 'string' && v.length > 200) throw new ApiError(400, 'bad_request', `Condition ${i + 1} value is too long`);
    return { field: c.field, op: c.op, value: v };
  });
  return { search, conditions };
}

const cleanName = (x: unknown) => {
  const n = String(x ?? '').trim();
  if (!n || n.length > 60) throw new ApiError(400, 'bad_request', 'Give the view a name of 60 characters or fewer');
  return n;
};

export function viewRoutes(app: FastifyInstance, { authed, can }: Kit) {
  const COLS = 'id, user_id, object, name, filter, is_shared, version';

  app.get('/v1/views', async (req) =>
    authed(req, async (db, userId) => {
      const object = String((req.query as any)?.object ?? '');
      if (!PERM[object]) throw new ApiError(400, 'bad_request', 'Pick accounts, contacts, deals or cases');
      await can(db, userId, PERM[object], 'read');
      const r = await db.query(
        `SELECT ${COLS}, (user_id = $2) AS mine, (SELECT display_name FROM app_user u WHERE u.id = saved_view.user_id) AS owner_name
           FROM saved_view WHERE object = $1 AND deleted_at IS NULL AND (user_id = $2 OR is_shared) ORDER BY lower(name)`, [object, userId]);
      return { data: r.rows };
    }));

  app.post('/v1/views', async (req, reply) => {
    const row = await authed(req, async (db, userId) => {
      const b: any = req.body ?? {};
      if (!PERM[b.object]) throw new ApiError(400, 'bad_request', 'Pick accounts, contacts, deals or cases');
      await can(db, userId, PERM[b.object], 'read');
      const tenantId = (await db.query(`SELECT current_tenant_id() AS t`)).rows[0].t;
      const r = await db.query(
        `INSERT INTO saved_view (tenant_id, user_id, object, name, filter, is_shared) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLS}, true AS mine`,
        [tenantId, userId, b.object, cleanName(b.name), JSON.stringify(cleanFilter(b.filter ?? {})), b.is_shared === true]);
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  // Only the person who made a view can change or remove it.
  app.patch('/v1/views/:id', async (req) =>
    authed(req, async (db, userId) => {
      const { id } = req.params as { id: string };
      if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Not found');
      const cur = (await db.query(`SELECT * FROM saved_view WHERE id = $1 AND deleted_at IS NULL AND (user_id = $2 OR is_shared)`, [id, userId])).rows[0];
      if (!cur) throw new ApiError(404, 'not_found', 'Not found');
      if (cur.user_id !== userId) throw new ApiError(403, 'forbidden', 'Only the person who made this view can change it');
      const b: any = req.body ?? {};
      const r = await db.query(
        `UPDATE saved_view SET name = $2, filter = $3, is_shared = $4 WHERE id = $1 RETURNING ${COLS}, true AS mine`,
        [id, b.name === undefined ? cur.name : cleanName(b.name), b.filter === undefined ? cur.filter : JSON.stringify(cleanFilter(b.filter)), b.is_shared === undefined ? cur.is_shared : b.is_shared === true]);
      return r.rows[0];
    }));

  app.delete('/v1/views/:id', async (req, reply) => {
    await authed(req, async (db, userId) => {
      const { id } = req.params as { id: string };
      if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Not found');
      const cur = (await db.query(`SELECT user_id FROM saved_view WHERE id = $1 AND deleted_at IS NULL AND (user_id = $2 OR is_shared)`, [id, userId])).rows[0];
      if (!cur) throw new ApiError(404, 'not_found', 'Not found');
      if (cur.user_id !== userId) throw new ApiError(403, 'forbidden', 'Only the person who made this view can remove it');
      await db.query(`UPDATE saved_view SET deleted_at = now() WHERE id = $1`, [id]);
    });
    return reply.status(204).send();
  });
}
