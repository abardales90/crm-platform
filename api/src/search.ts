import type { FastifyInstance } from 'fastify';
import type { Kit } from './kit.js';

// One search box for the whole app. Each kind of record is only searched when the
// caller may read it, and a field is only searched or shown when the caller may see it.
// Several words must all appear, in any order and in any searched field of the same record.
type Col = { c: string; label: string };
type Spec = {
  key: string; perm: string; table: string;
  cols: Col[];            // fields that are searched, in the order a preview is picked
  title: string;          // SQL for the heading of a result
  titleCols: string[];    // fields the heading needs (all must be visible)
  sub?: string; subKind?: 'status' | 'money' | 'plain'; // one short extra value shown beside the heading
  where?: string;         // extra fixed condition
  link: (row: any) => { href: string; id: string } | null;
  extra?: string[];       // columns read only to build the link
  caseNumber?: boolean;   // a number like #12 also matches the case number
};

const parent = (r: any) =>
  r.case_id ? { href: 'cases', id: r.case_id } : r.opportunity_id ? { href: 'deals', id: r.opportunity_id }
  : r.contact_id ? { href: 'contacts', id: r.contact_id } : r.account_id ? { href: 'accounts', id: r.account_id } : null;

const SPECS: Spec[] = [
  { key: 'accounts', perm: 'account', table: 'account', title: 'name', titleCols: ['name'], sub: 'domain', subKind: 'plain',
    cols: [{ c: 'name', label: 'Name' }, { c: 'domain', label: 'Domain' }, { c: 'website', label: 'Website' }, { c: 'industry', label: 'Industry' }, { c: 'phone', label: 'Phone' }, { c: 'description', label: 'Notes' }],
    link: (r) => ({ href: 'accounts', id: r.id }) },
  { key: 'contacts', perm: 'contact', table: 'contact', title: `btrim(coalesce(first_name, '') || ' ' || last_name)`, titleCols: ['first_name', 'last_name'], sub: 'email', subKind: 'plain',
    cols: [{ c: 'first_name', label: 'First name' }, { c: 'last_name', label: 'Last name' }, { c: 'email', label: 'Email' }, { c: 'phone', label: 'Phone' }, { c: 'mobile', label: 'Mobile' }, { c: 'title', label: 'Job title' }, { c: 'department', label: 'Department' }, { c: 'description', label: 'Notes' }],
    link: (r) => ({ href: 'contacts', id: r.id }) },
  { key: 'deals', perm: 'opportunity', table: 'opportunity', title: 'name', titleCols: ['name'], sub: 'amount', subKind: 'money',
    cols: [{ c: 'name', label: 'Name' }, { c: 'next_step', label: 'Next step' }, { c: 'loss_reason', label: 'Loss reason' }, { c: 'description', label: 'Notes' }],
    link: (r) => ({ href: 'deals', id: r.id }) },
  { key: 'cases', perm: 'case', table: 'support_case', title: `'#' || case_number || ' ' || subject`, titleCols: ['subject', 'case_number'], sub: 'status', subKind: 'status', caseNumber: true,
    cols: [{ c: 'subject', label: 'Subject' }, { c: 'description', label: 'Description' }],
    link: (r) => ({ href: 'cases', id: r.id }) },
  { key: 'activities', perm: 'activity', table: 'activity', title: 'subject', titleCols: ['subject'], sub: 'type', subKind: 'plain',
    cols: [{ c: 'subject', label: 'Subject' }, { c: 'body', label: 'Details' }],
    extra: ['account_id', 'contact_id', 'opportunity_id', 'case_id'], link: parent },
  { key: 'replies', perm: 'case_comment', table: 'case_comment', title: `'Reply on case #' || (SELECT case_number FROM support_case c WHERE c.id = case_comment.case_id)`, titleCols: [],
    cols: [{ c: 'body', label: 'Message' }],
    extra: ['case_id'], link: (r) => ({ href: 'cases', id: r.case_id }) },
];
export const SEARCH_KEYS = SPECS.map((s) => s.key);

const likeSafe = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

// A short piece of the text around the first match, with the matched words left in place.
export function snippetOf(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  let at = -1, len = 0;
  for (const t of terms) {
    const i = low.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) { at = i; len = t.length; }
  }
  if (at < 0) return flat.slice(0, 140) + (flat.length > 140 ? '…' : '');
  const start = Math.max(0, at - 50), end = Math.min(flat.length, at + len + 90);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

export function searchRoutes(app: FastifyInstance, { authed }: Kit) {
  app.get('/v1/search', async (req) =>
    authed(req, async (db, userId) => {
      const qs = (req.query ?? {}) as Record<string, string>;
      const raw = String(qs.q ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const terms = raw.split(' ').filter(Boolean).slice(0, 5);
      const limit = Math.min(Math.max(parseInt(qs.limit ?? '8', 10) || 8, 1), 20);
      const only = qs.types ? new Set(String(qs.types).split(',')) : null;
      if (raw.length < 2) return { q: raw, terms: [], groups: [] };
      const seeable = async (object: string, col: string) =>
        (await db.query(`SELECT field_access($1::uuid, $2, $3) AS a`, [userId, object, col])).rows[0].a !== 'none';
      const groups: { key: string; rows: any[] }[] = [];
      for (const s of SPECS) {
        if (only && !only.has(s.key)) continue;
        const can = (await db.query(`SELECT can_do($1::uuid, $2, 'read') AS ok`, [userId, s.perm])).rows[0].ok;
        if (!can) continue;
        if (!(await Promise.all(s.titleCols.map((c) => seeable(s.perm, c)))).every(Boolean)) continue;
        const cols: Col[] = [];
        for (const c of s.cols) if (await seeable(s.perm, c.c)) cols.push(c);
        const sub = s.sub && (await seeable(s.perm, s.sub)) ? s.sub : null;
        // Every word must match somewhere on the same record.
        const args: string[] = [];
        const perWord = terms.map((t) => {
          args.push(`%${likeSafe(t)}%`);
          const tests = cols.map((c) => `${c.c}::text ILIKE $${args.length} ESCAPE '\\'`);
          if (s.caseNumber && /^#?\d{1,9}$/.test(t)) tests.push(`case_number = ${parseInt(t.replace('#', ''), 10)}`);
          return tests.length ? `(${tests.join(' OR ')})` : 'false';
        });
        const selectCols = [...new Set([...cols.map((c) => c.c), ...(s.extra ?? [])])];
        const first = `%${likeSafe(terms[0])}%`;
        args.push(first);
        const r = await db.query(
          `SELECT id, ${s.title} AS _title, ${sub ? `${sub}::text` : 'NULL'} AS _sub${selectCols.length ? ', ' + selectCols.map((c) => `${c}::text AS "c_${c}"`).join(', ') : ''}
           FROM ${s.table}
           WHERE deleted_at IS NULL AND ${perWord.join(' AND ')}
           ORDER BY (${s.title}) ILIKE $${args.length} ESCAPE '\\' DESC, created_at DESC LIMIT ${limit}`,
          args);
        const rows = r.rows.map((row) => {
          const plain: any = { id: row.id };
          for (const c of selectCols) plain[c] = row[`c_${c}`];
          const link = s.link(plain);
          // A preview comes from the first matching field that is not already the heading or the extra value.
          const skip = new Set([...s.titleCols, ...(sub ? [sub] : [])]);
          const val = (c: string) => row[`c_${c}`] as string | null;
          const hit = cols.find((c) => !skip.has(c.c) && val(c.c) && terms.some((t) => val(c.c)!.toLowerCase().includes(t.toLowerCase())));
          return {
            id: link?.id ?? row.id, href: link?.href ?? s.key, title: row._title, sub: row._sub, sub_kind: sub ? s.subKind : null,
            matched: hit?.label ?? null, snippet: hit ? snippetOf(val(hit.c)!, terms) : null,
          };
        }).filter((x) => x.id);
        if (rows.length) groups.push({ key: s.key, rows });
      }
      return { q: raw, terms, groups };
    }));
}
