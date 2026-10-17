import type { FastifyInstance } from 'fastify';
import { type Kit, UUID } from './kit.js';
import { ApiError } from './errors.js';
import type { Db } from './db.js';

export const OBJECTS = ['account', 'contact', 'opportunity', 'case'] as const;
export const KINDS = ['text', 'long text', 'number', 'date', 'checkbox', 'pick one'] as const;
const MAX_PER_OBJECT = 20;

type Def = { key: string; label: string; kind: string; options: string[] | null; required: boolean };

export async function defsFor(db: Db, object: string, includeRemoved = false): Promise<Def[]> {
  const r = await db.query(
    `SELECT key, label, kind, options, required FROM custom_field WHERE object = $1 ${includeRemoved ? '' : 'AND deleted_at IS NULL'} ORDER BY sort_order, created_at`, [object]);
  return r.rows;
}

// Checks the "custom" values sent with a record. On create every required field must be present.
// On update only the keys that are sent are checked, and a null removes a value.
export async function cleanCustom(db: Db, object: string, value: unknown, mode: 'create' | 'update'): Promise<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'bad_request', 'custom must be an object');
  const defs = await defsFor(db, object);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const d = byKey.get(k);
    if (!d) throw new ApiError(400, 'unknown_field', `Unknown custom field: ${k}`);
    if (v === null || v === '') {
      if (d.required) throw new ApiError(400, 'required_field', `${d.label} is required`);
      if (mode === 'update') out[k] = null;
      continue;
    }
    switch (d.kind) {
      case 'text': case 'long text':
        if (typeof v !== 'string') throw new ApiError(400, 'bad_value', `${d.label} must be text`);
        if (v.length > (d.kind === 'text' ? 300 : 5000)) throw new ApiError(400, 'bad_value', `${d.label} is too long`);
        out[k] = v; break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new ApiError(400, 'bad_value', `${d.label} must be a number`);
        out[k] = v; break;
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new ApiError(400, 'bad_value', `${d.label} must be a date like 2026-10-17`);
        out[k] = v; break;
      case 'checkbox':
        if (typeof v !== 'boolean') throw new ApiError(400, 'bad_value', `${d.label} must be yes or no`);
        out[k] = v; break;
      case 'pick one':
        if (typeof v !== 'string' || !d.options!.includes(v)) throw new ApiError(400, 'bad_value', `${d.label} must be one of: ${d.options!.join(', ')}`);
        out[k] = v; break;
    }
  }
  if (mode === 'create') for (const d of defs) if (d.required && out[d.key] === undefined) throw new ApiError(400, 'required_field', `${d.label} is required`);
  return out;
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[0-9]+/, '').slice(0, 40);

function cleanOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ApiError(400, 'bad_request', 'Give the choices as a list');
  const opts = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  if (opts.length < 1 || opts.length > 30) throw new ApiError(400, 'bad_request', 'A pick one field needs 1 to 30 choices');
  if (opts.some((o) => o.length > 60)) throw new ApiError(400, 'bad_request', 'Each choice must be 60 characters or fewer');
  return opts;
}

export function customFieldRoutes(app: FastifyInstance, { authed, can }: Kit) {
  // Everyone signed in may read the definitions (the screens need them). Only admins change them.
  app.get('/v1/settings/custom-fields', async (req) =>
    authed(req, async (db) => {
      const r = await db.query(`SELECT id, object, key, label, kind, options, required, sort_order, version FROM custom_field WHERE deleted_at IS NULL ORDER BY object, sort_order, created_at`);
      return { data: r.rows };
    }));

  app.post('/v1/settings/custom-fields', async (req, reply) => {
    const row = await authed(req, async (db, userId) => {
      await can(db, userId, 'app_user', 'edit');
      const b: any = req.body ?? {};
      if (!OBJECTS.includes(b.object)) throw new ApiError(400, 'bad_request', 'Pick accounts, contacts, deals or cases');
      if (!KINDS.includes(b.kind)) throw new ApiError(400, 'bad_request', 'Pick a kind of field');
      const label = String(b.label ?? '').trim();
      if (!label || label.length > 60) throw new ApiError(400, 'bad_request', 'Give the field a name of 60 characters or fewer');
      const key = slug(label);
      if (!key) throw new ApiError(400, 'bad_request', 'Start the name with a letter');
      const options = b.kind === 'pick one' ? cleanOptions(b.options) : null;
      const n = (await db.query(`SELECT count(*)::int AS n FROM custom_field WHERE object = $1 AND deleted_at IS NULL`, [b.object])).rows[0].n;
      if (n >= MAX_PER_OBJECT) throw new ApiError(400, 'too_many_fields', `You can add up to ${MAX_PER_OBJECT} custom fields on each record type`);
      const taken = await db.query(`SELECT 1 FROM custom_field WHERE object = $1 AND key = $2`, [b.object, key]);
      if (taken.rowCount) throw new ApiError(409, 'duplicate', 'A field with that name already exists (or did before). Pick a different name');
      const tenantId = (await db.query(`SELECT current_tenant_id() AS t`)).rows[0].t;
      const r = await db.query(
        `INSERT INTO custom_field (tenant_id, object, key, label, kind, options, required, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7, (SELECT coalesce(max(sort_order), 0) + 1 FROM custom_field WHERE object = $2))
         RETURNING id, object, key, label, kind, options, required, sort_order, version`,
        [tenantId, b.object, key, label, b.kind, options, b.required === true]);
      return r.rows[0];
    });
    return reply.status(201).send(row);
  });

  // Rename, change the choices, or toggle required. The kind and key never change, so saved values stay valid.
  app.patch('/v1/settings/custom-fields/:id', async (req) =>
    authed(req, async (db, userId) => {
      await can(db, userId, 'app_user', 'edit');
      const { id } = req.params as { id: string };
      if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Not found');
      const cur = (await db.query(`SELECT * FROM custom_field WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
      if (!cur) throw new ApiError(404, 'not_found', 'Not found');
      const b: any = req.body ?? {};
      const label = b.label === undefined ? cur.label : String(b.label).trim();
      if (!label || label.length > 60) throw new ApiError(400, 'bad_request', 'Give the field a name of 60 characters or fewer');
      const options = cur.kind === 'pick one' && b.options !== undefined ? cleanOptions(b.options) : cur.options;
      const required = b.required === undefined ? cur.required : b.required === true;
      const r = await db.query(
        `UPDATE custom_field SET label = $2, options = $3, required = $4 WHERE id = $1
         RETURNING id, object, key, label, kind, options, required, sort_order, version`, [id, label, options, required]);
      return r.rows[0];
    }));

  // Removing hides the field everywhere. Values already saved on records are kept, not erased.
  app.delete('/v1/settings/custom-fields/:id', async (req, reply) => {
    await authed(req, async (db, userId) => {
      await can(db, userId, 'app_user', 'edit');
      const { id } = req.params as { id: string };
      if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Not found');
      const r = await db.query(`UPDATE custom_field SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (r.rowCount === 0) throw new ApiError(404, 'not_found', 'Not found');
    });
    return reply.status(204).send();
  });
}
