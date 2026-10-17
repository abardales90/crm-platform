import type { FastifyInstance } from 'fastify';
import type { Kit } from './kit.js';
import { ApiError } from './errors.js';

export const ACCENTS = ['green', 'blue', 'purple', 'orange', 'rose', 'slate'];

const COLS = `accent, tour_done_at, last_seen_release`;

// A person's own look and welcome state. Needs no special permission, and only ever touches the caller's row.
export function prefRoutes(app: FastifyInstance, kit: Kit) {
  const { authed } = kit;

  app.get('/v1/me/preferences', async (req) =>
    authed(req, async (db, userId) => {
      const r = await db.query(`SELECT ${COLS} FROM user_preference WHERE user_id = $1`, [userId]);
      return r.rows[0] ?? { accent: null, tour_done_at: null, last_seen_release: null };
    }));

  app.put('/v1/me/preferences', async (req) =>
    authed(req, async (db, userId) => {
      const b: any = req.body ?? {};
      const sets: string[] = []; const vals: unknown[] = [];
      if (b.accent !== undefined) {
        if (!ACCENTS.includes(b.accent)) throw new ApiError(400, 'bad_request', 'Pick one of the listed colors');
        vals.push(b.accent); sets.push(`accent = $${vals.length + 2}`);
      }
      if (b.tour_done === true) sets.push(`tour_done_at = COALESCE(user_preference.tour_done_at, now())`);
      else if (b.tour_done !== undefined) throw new ApiError(400, 'bad_request', 'tour_done can only be set to true');
      if (b.last_seen_release !== undefined) {
        if (typeof b.last_seen_release !== 'string' || !b.last_seen_release || b.last_seen_release.length > 40) throw new ApiError(400, 'bad_request', 'Unknown release');
        vals.push(b.last_seen_release); sets.push(`last_seen_release = $${vals.length + 2}`);
      }
      if (!sets.length) throw new ApiError(400, 'bad_request', 'Nothing to save');
      const tenantId = (await db.query(`SELECT current_tenant_id() AS t`)).rows[0].t;
      // Insert the row the first time, update it after that. $1 is the person, $2 the workspace.
      const cols = sets.map((s) => s.split(' = ')[0]);
      const insertVals = sets.map((s) => s.includes('now()') ? 'now()' : s.match(/\$\d+/)![0]);
      const r = await db.query(
        `INSERT INTO user_preference (tenant_id, user_id, ${cols.join(', ')}) VALUES ($2, $1, ${insertVals.join(', ')})
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET ${sets.join(', ')}
         RETURNING ${COLS}`, [userId, tenantId, ...vals]);
      return r.rows[0];
    }));
}
