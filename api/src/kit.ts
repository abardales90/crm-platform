import type { FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { ApiError } from './errors.js';

// Helpers app.ts hands to each route module.
export type Kit = {
  authed: <T>(req: FastifyRequest, fn: (db: Db, userId: string) => Promise<T>) => Promise<T>;
  can: (db: Db, userId: string, perm: string, action: 'read' | 'create' | 'edit' | 'delete') => Promise<void>;
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Reports show totals, so a hidden field must stay hidden there too.
export async function needField(db: Db, userId: string, object: string, fields: string[]) {
  for (const f of fields) {
    const r = await db.query(`SELECT field_access($1::uuid, $2, $3) AS a`, [userId, object, f]);
    if (r.rows[0].a === 'none') throw new ApiError(403, 'field_forbidden', `Your role cannot see ${f.replace(/_/g, ' ')}, so this report is not available to you`);
  }
}
