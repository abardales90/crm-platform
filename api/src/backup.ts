import type { FastifyInstance } from 'fastify';
import type { Kit } from './kit.js';

// Every table that holds the workspace's own information, in an order that is safe to read back in.
// Sign in details, audit history and AI logs are not part of this copy.
export const BACKUP_TABLES = [
  'app_user', 'role', 'user_role', 'role_permission', 'field_permission',
  'pipeline_stage', 'queue', 'sla_policy', 'custom_field',
  'account', 'contact', 'opportunity', 'support_case', 'case_comment', 'activity', 'email_message',
  'external_id', 'saved_view', 'user_preference',
] as const;

// These join tables have no id column of their own.
const NO_ID = new Set<string>(['user_role', 'role_permission', 'field_permission']);

export function backupRoutes(app: FastifyInstance, { authed, can }: Kit) {
  // One file with everything in this workspace. Admins only. Includes records that were deleted, so nothing is lost.
  app.get('/v1/settings/backup', async (req, reply) => {
    const body = await authed(req, async (db, userId) => {
      await can(db, userId, 'app_user', 'edit');
      const t = (await db.query(`SELECT name, default_currency FROM tenant`)).rows[0];
      const tables: Record<string, unknown[]> = {};
      const counts: Record<string, number> = {};
      for (const name of BACKUP_TABLES) {
        const r = await db.query(`SELECT * FROM "${name}" ORDER BY ${NO_ID.has(name) ? '1, 2, 3' : 'id'}`);
        tables[name] = r.rows;
        counts[name] = r.rowCount ?? 0;
      }
      return { format: 'tally-backup', version: 1, created_at: new Date().toISOString(), workspace: t, counts, tables };
    });
    reply.header('content-disposition', `attachment; filename="tally-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    reply.header('cache-control', 'no-store');
    return body;
  });
}
