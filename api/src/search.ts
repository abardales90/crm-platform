import type { FastifyInstance } from 'fastify';
import type { Kit } from './kit.js';

// One search box for the whole app. Each kind of record is only searched when the
// caller may read it, and a field is only searched or shown when the caller may see it.
type Spec = { key: string; perm: string; table: string; href: string; searchCols: string[]; title: string; titleCols: string[]; sub?: string };

const SPECS: Spec[] = [
  { key: 'accounts', perm: 'account', table: 'account', href: 'accounts', searchCols: ['name', 'domain'], title: 'name', titleCols: ['name'], sub: 'domain' },
  { key: 'contacts', perm: 'contact', table: 'contact', href: 'contacts', searchCols: ['first_name', 'last_name', 'email'],
    title: `btrim(coalesce(first_name, '') || ' ' || last_name)`, titleCols: ['last_name'], sub: 'email' },
  { key: 'deals', perm: 'opportunity', table: 'opportunity', href: 'deals', searchCols: ['name'], title: 'name', titleCols: ['name'] },
  { key: 'cases', perm: 'case', table: 'support_case', href: 'cases', searchCols: ['subject'],
    title: `'#' || case_number || ' ' || subject`, titleCols: ['subject', 'case_number'], sub: 'status' },
];

const likeSafe = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export function searchRoutes(app: FastifyInstance, { authed }: Kit) {
  app.get('/v1/search', async (req) =>
    authed(req, async (db, userId) => {
      const raw = String((req.query as any)?.q ?? '').trim().slice(0, 80);
      if (raw.length < 2) return { q: raw, groups: [] };
      const pattern = `%${likeSafe(raw)}%`;
      const seeable = async (object: string, col: string) =>
        (await db.query(`SELECT field_access($1::uuid, $2, $3) AS a`, [userId, object, col])).rows[0].a !== 'none';
      const groups: { key: string; href: string; rows: { id: string; title: string; sub: string | null }[] }[] = [];
      for (const s of SPECS) {
        const can = (await db.query(`SELECT can_do($1::uuid, $2, 'read') AS ok`, [userId, s.perm])).rows[0].ok;
        if (!can) continue;
        const titleOk = (await Promise.all(s.titleCols.map((c) => seeable(s.perm, c)))).every(Boolean);
        if (!titleOk) continue;
        const cols: string[] = [];
        for (const c of s.searchCols) if (await seeable(s.perm, c)) cols.push(c);
        const exact = s.key === 'cases' && /^#?\d{1,9}$/.test(raw) ? `case_number = ${parseInt(raw.replace('#', ''), 10)}` : null;
        const likes = cols.map((c) => `${c} ILIKE $1 ESCAPE '\\'`);
        const tests = [...likes, ...(exact ? [exact] : [])];
        if (tests.length === 0) continue;
        const sub = s.sub && (await seeable(s.perm, s.sub)) ? s.sub : null;
        const r = await db.query(
          `SELECT id, ${s.title} AS title, ${sub ? sub + '::text' : 'NULL'} AS sub FROM ${s.table}
           WHERE deleted_at IS NULL AND (${tests.join(' OR ')}) ORDER BY ${s.key === 'cases' ? 'created_at DESC' : 'title'} LIMIT 8`,
          [pattern]);
        if (r.rows.length) groups.push({ key: s.key, href: s.href, rows: r.rows });
      }
      return { q: raw, groups };
    }));
}
