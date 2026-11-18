import type { FastifyInstance } from 'fastify';
import { type Kit, UUID } from './kit.js';
import { ApiError } from './errors.js';
import type { Db } from './db.js';
import { renderMarkdown } from './kbmd.js';

export const TYPES = ['how_to', 'troubleshooting', 'faq'] as const;
export const AUDIENCES = ['public', 'internal'] as const;
const STATUSES = ['draft', 'in_review', 'published', 'archived'] as const;

// Knowledge has no permission rows of its own yet, so it borrows from the case permissions:
// read = can read cases, write = can edit cases, approve = can delete cases (leads and admins),
// help center settings = can edit users (admins).
async function need(kit: Kit, db: Db, userId: string, level: 'read' | 'write' | 'approve' | 'settings') {
  if (level === 'read') return kit.can(db, userId, 'case', 'read');
  if (level === 'write') return kit.can(db, userId, 'case', 'edit');
  if (level === 'approve') return kit.can(db, userId, 'case', 'delete');
  return kit.can(db, userId, 'app_user', 'edit');
}
async function isApprover(db: Db, userId: string) {
  return (await db.query(`SELECT can_do($1::uuid, 'case', 'delete') AS ok`, [userId])).rows[0].ok as boolean;
}
async function isAdmin(db: Db, userId: string) {
  return (await db.query(`SELECT can_do($1::uuid, 'app_user', 'edit') AS ok`, [userId])).rows[0].ok as boolean;
}

export const slugify = (s: string, max = 70) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');

async function freeSlug(db: Db, table: 'kb_article' | 'kb_category', base: string, exceptId?: string) {
  const root = base || 'article';
  for (let n = 0; n < 50; n++) {
    const s = n === 0 ? root : `${root}-${n + 1}`;
    const r = await db.query(`SELECT 1 FROM ${table} WHERE slug = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`, [s, exceptId ?? null]);
    if (r.rowCount === 0) return s;
  }
  throw new ApiError(409, 'slug_taken', 'Could not find a free address for this title');
}

function str(v: unknown, field: string, max: number, required = false): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ApiError(400, 'bad_request', `${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new ApiError(400, 'bad_request', `${field} must be text`);
  if (v.length > max) throw new ApiError(400, 'bad_request', `${field} is too long (limit ${max} characters)`);
  return v;
}

export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ApiError(400, 'bad_request', 'tags must be a list');
  const t = [...new Set(raw.map((x) => String(x).trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean))];
  if (t.some((x) => x.length > 40)) throw new ApiError(400, 'bad_request', 'A tag can be at most 40 characters');
  if (t.length > 15) throw new ApiError(400, 'bad_request', 'At most 15 tags per article');
  return t;
}

const ARTICLE_COLS = `id, type, title, slug, summary, body, audience, status, category_id, tags, product_area, owner_user_id,
  reviewer_user_id, review_note, submitted_at, published_version_id, published_at, ai_drafted, source_case_id,
  created_at, updated_at, created_by, updated_by, version`;

async function load(db: Db, id: string) {
  if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Article not found');
  const r = await db.query(`SELECT ${ARTICLE_COLS} FROM kb_article WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (r.rowCount === 0) throw new ApiError(404, 'not_found', 'Article not found');
  return r.rows[0];
}

async function checkCategory(db: Db, id: unknown) {
  if (id === null || id === undefined || id === '') return null;
  if (typeof id !== 'string' || !UUID.test(id)) throw new ApiError(400, 'bad_request', 'Unknown category');
  const r = await db.query(`SELECT 1 FROM kb_category WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (r.rowCount === 0) throw new ApiError(400, 'bad_request', 'Unknown category');
  return id;
}

export function knowledgeRoutes(app: FastifyInstance, kit: Kit) {
  const { authed } = kit;

  // ---- help center settings
  app.get('/v1/kb/site', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'read');
    const r = await db.query(`SELECT slug, enabled, title, tagline, accent FROM kb_site WHERE tenant_id = current_tenant_id()`);
    return { data: r.rows[0] ?? null };
  }));

  app.put('/v1/kb/site', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'settings');
    const b: any = req.body ?? {};
    const title = str(b.title, 'title', 80, true)!.trim();
    const tagline = str(b.tagline, 'tagline', 160);
    const accent = b.accent ? String(b.accent) : null;
    if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) throw new ApiError(400, 'bad_request', 'Colour must look like #1a73e8');
    const slug = String(b.slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw new ApiError(400, 'bad_request', 'The web address needs 2 to 63 letters, numbers or dashes');
    const enabled = b.enabled === true;
    const taken = await db.query(`SELECT 1 FROM kb_site WHERE slug = $1 AND tenant_id <> current_tenant_id()`, [slug]);
    if (taken.rowCount) throw new ApiError(409, 'slug_taken', 'That web address is already used by another company');
    const r = await db.query(
      `INSERT INTO kb_site (tenant_id, slug, enabled, title, tagline, accent)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id) DO UPDATE SET slug = $1, enabled = $2, title = $3, tagline = $4, accent = $5
       RETURNING slug, enabled, title, tagline, accent`, [slug, enabled, title, tagline, accent]);
    return { data: r.rows[0] };
  }));

  // ---- categories
  app.get('/v1/kb/categories', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'read');
    const r = await db.query(
      `SELECT c.id, c.name, c.slug, c.description, c.sort_order, c.version,
              (SELECT count(*) FROM kb_article a WHERE a.category_id = c.id AND a.deleted_at IS NULL AND a.status <> 'archived')::int AS articles
         FROM kb_category c WHERE c.deleted_at IS NULL ORDER BY c.sort_order, c.name`);
    return { data: r.rows };
  }));

  app.post('/v1/kb/categories', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'approve');
    const b: any = req.body ?? {};
    const name = str(b.name, 'name', 60, true)!.trim();
    const slug = await freeSlug(db, 'kb_category', slugify(name, 60));
    const r = await db.query(
      `INSERT INTO kb_category (tenant_id, name, slug, description, sort_order)
       VALUES (current_tenant_id(), $1, $2, $3, $4) RETURNING id, name, slug, description, sort_order, version`,
      [name, slug, str(b.description, 'description', 300), Number.isInteger(b.sort_order) ? b.sort_order : 0]);
    return { data: r.rows[0] };
  }));

  app.patch('/v1/kb/categories/:id', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'approve');
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Category not found');
    const b: any = req.body ?? {};
    const cur = await db.query(`SELECT id, version FROM kb_category WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (cur.rowCount === 0) throw new ApiError(404, 'not_found', 'Category not found');
    if (b.version !== undefined && b.version !== cur.rows[0].version) throw new ApiError(409, 'version_conflict', 'Someone else changed this category. Reload and try again.');
    const sets: string[] = []; const args: unknown[] = [];
    if (b.name !== undefined) { args.push(str(b.name, 'name', 60, true)!.trim()); sets.push(`name = $${args.length}`); }
    if (b.description !== undefined) { args.push(str(b.description, 'description', 300)); sets.push(`description = $${args.length}`); }
    if (b.sort_order !== undefined) { if (!Number.isInteger(b.sort_order)) throw new ApiError(400, 'bad_request', 'sort_order must be a whole number'); args.push(b.sort_order); sets.push(`sort_order = $${args.length}`); }
    if (b.deleted === true) sets.push(`deleted_at = now()`);
    if (!sets.length) throw new ApiError(400, 'bad_request', 'Nothing to change');
    args.push(id);
    const r = await db.query(`UPDATE kb_category SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING id, name, slug, description, sort_order, version`, args);
    return { data: r.rows[0] };
  }));

  // ---- articles
  app.get('/v1/kb/articles', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'read');
    const qs = req.query as Record<string, string>;
    const where = ['a.deleted_at IS NULL']; const args: unknown[] = [];
    if (qs.status) { if (!(STATUSES as readonly string[]).includes(qs.status)) throw new ApiError(400, 'bad_request', 'Unknown status'); args.push(qs.status); where.push(`a.status = $${args.length}`); }
    else if (qs.include_archived !== 'true') where.push(`a.status <> 'archived'`);
    if (qs.type) { if (!(TYPES as readonly string[]).includes(qs.type)) throw new ApiError(400, 'bad_request', 'Unknown type'); args.push(qs.type); where.push(`a.type = $${args.length}`); }
    if (qs.audience) { if (!(AUDIENCES as readonly string[]).includes(qs.audience)) throw new ApiError(400, 'bad_request', 'Unknown audience'); args.push(qs.audience); where.push(`a.audience = $${args.length}`); }
    if (qs.category_id) { if (!UUID.test(qs.category_id)) throw new ApiError(400, 'bad_request', 'Unknown category'); args.push(qs.category_id); where.push(`a.category_id = $${args.length}`); }
    if (qs.q) { args.push(`%${qs.q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(a.title ILIKE $${args.length} OR a.summary ILIKE $${args.length} OR a.body ILIKE $${args.length} OR array_to_string(a.tags, ' ') ILIKE $${args.length})`); }
    const limit = Math.min(Math.max(parseInt(qs.limit ?? '100', 10) || 100, 1), 200);
    args.push(limit);
    const r = await db.query(
      `SELECT a.id, a.type, a.title, a.slug, a.summary, a.audience, a.status, a.category_id, a.tags, a.owner_user_id,
              a.ai_drafted, a.published_at, a.published_version_id, a.submitted_at, a.updated_at,
              u.display_name AS owner_name, COALESCE(s.views, 0)::int AS views, COALESCE(s.helpful_yes, 0) AS helpful_yes, COALESCE(s.helpful_no, 0) AS helpful_no
         FROM kb_article a
         LEFT JOIN app_user u ON u.id = a.owner_user_id
         LEFT JOIN kb_stat s ON s.article_id = a.id
        WHERE ${where.join(' AND ')} ORDER BY a.updated_at DESC LIMIT $${args.length}`, args);
    return { data: r.rows };
  }));

  app.get('/v1/kb/articles/:id', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'read');
    const a = await load(db, (req.params as any).id);
    const v = await db.query(`SELECT version_no, title, published_at, published_by, change_note FROM kb_article_version WHERE article_id = $1 ORDER BY version_no DESC`, [a.id]);
    return { data: { ...a, history: v.rows } };
  }));

  app.post('/v1/kb/articles', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'write');
    const b: any = req.body ?? {};
    const title = str(b.title, 'title', 200, true)!.trim();
    if (!(TYPES as readonly string[]).includes(b.type)) throw new ApiError(400, 'bad_request', 'type must be how_to, troubleshooting or faq');
    const audience = b.audience ?? 'public';
    if (!(AUDIENCES as readonly string[]).includes(audience)) throw new ApiError(400, 'bad_request', 'audience must be public or internal');
    const slug = await freeSlug(db, 'kb_article', slugify(title));
    const cat = await checkCategory(db, b.category_id);
    const r = await db.query(
      `INSERT INTO kb_article (tenant_id, type, title, slug, summary, body, audience, category_id, tags, product_area, owner_user_id)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [b.type, title, slug, str(b.summary, 'summary', 400), str(b.body, 'body', 60000) ?? '', audience, cat,
       cleanTags(b.tags ?? []), str(b.product_area, 'product_area', 60), uid]);
    return { data: await load(db, r.rows[0].id) };
  }));

  app.patch('/v1/kb/articles/:id', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'write');
    const a = await load(db, (req.params as any).id);
    const b: any = req.body ?? {};
    if (a.status === 'in_review') throw new ApiError(409, 'in_review', 'This article is waiting for review. Ask the reviewer to send it back before changing it.');
    if (a.status === 'archived') throw new ApiError(409, 'archived', 'This article is archived. Restore it first.');
    if (b.version !== undefined && b.version !== a.version) throw new ApiError(409, 'version_conflict', 'Someone else changed this article. Reload to see their changes.');
    const sets: string[] = []; const args: unknown[] = [];
    const set = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };
    if (b.title !== undefined) set('title', str(b.title, 'title', 200, true)!.trim());
    if (b.summary !== undefined) set('summary', str(b.summary, 'summary', 400));
    if (b.body !== undefined) set('body', str(b.body, 'body', 60000) ?? '');
    if (b.type !== undefined) { if (!(TYPES as readonly string[]).includes(b.type)) throw new ApiError(400, 'bad_request', 'Unknown type'); set('type', b.type); }
    if (b.audience !== undefined) { if (!(AUDIENCES as readonly string[]).includes(b.audience)) throw new ApiError(400, 'bad_request', 'Unknown audience'); set('audience', b.audience); }
    if (b.category_id !== undefined) set('category_id', await checkCategory(db, b.category_id));
    if (b.tags !== undefined) set('tags', cleanTags(b.tags));
    if (b.product_area !== undefined) set('product_area', str(b.product_area, 'product_area', 60));
    if (b.owner_user_id !== undefined) {
      if (typeof b.owner_user_id !== 'string' || !UUID.test(b.owner_user_id)) throw new ApiError(400, 'bad_request', 'Unknown owner');
      set('owner_user_id', b.owner_user_id);
    }
    if (!sets.length) throw new ApiError(400, 'bad_request', 'Nothing to change');
    // An edit to a live article becomes a new draft. The public page keeps showing the approved copy until the edit is approved.
    if (a.status === 'published') sets.push(`status = 'draft'`);
    sets.push(`review_note = NULL`);
    args.push(a.id);
    await db.query(`UPDATE kb_article SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
    return { data: await load(db, a.id) };
  }));

  app.post('/v1/kb/articles/:id/submit', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'write');
    const a = await load(db, (req.params as any).id);
    if (a.status !== 'draft') throw new ApiError(409, 'bad_state', 'Only drafts can be sent for review');
    if (!a.body.trim()) throw new ApiError(400, 'bad_request', 'Add some text before sending for review');
    await db.query(`UPDATE kb_article SET status = 'in_review', submitted_at = now(), review_note = NULL WHERE id = $1`, [a.id]);
    return { data: await load(db, a.id) };
  }));

  // The person who last edited an article cannot approve it, unless they are an admin. AI drafts count as edited by the person who created them.
  app.post('/v1/kb/articles/:id/approve', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'approve');
    const a = await load(db, (req.params as any).id);
    if (a.status !== 'in_review') throw new ApiError(409, 'bad_state', 'This article is not waiting for review');
    if (a.updated_by === uid && !(await isAdmin(db, uid))) throw new ApiError(403, 'same_person', 'A second person needs to approve this article, since you made the last edit');
    const b: any = req.body ?? {};
    const note = str(b.change_note, 'change_note', 500);
    const no = (await db.query(`SELECT COALESCE(max(version_no), 0) + 1 AS n FROM kb_article_version WHERE article_id = $1`, [a.id])).rows[0].n;
    const v = await db.query(
      `INSERT INTO kb_article_version (tenant_id, article_id, version_no, type, title, summary, body, audience, category_id, tags, change_note)
       VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [a.id, no, a.type, a.title, a.summary, a.body, a.audience, a.category_id, a.tags, note]);
    await db.query(
      `UPDATE kb_article SET status = 'published', published_version_id = $2, published_at = now(), reviewer_user_id = $3, review_note = NULL WHERE id = $1`,
      [a.id, v.rows[0].id, uid]);
    return { data: await load(db, a.id) };
  }));

  app.post('/v1/kb/articles/:id/reject', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'approve');
    const a = await load(db, (req.params as any).id);
    if (a.status !== 'in_review') throw new ApiError(409, 'bad_state', 'This article is not waiting for review');
    const note = str((req.body as any)?.note, 'note', 1000, true);
    await db.query(`UPDATE kb_article SET status = 'draft', review_note = $2, reviewer_user_id = $3 WHERE id = $1`, [a.id, note, uid]);
    return { data: await load(db, a.id) };
  }));

  // Archiving takes an article off the public site at once.
  app.post('/v1/kb/articles/:id/archive', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'approve');
    const a = await load(db, (req.params as any).id);
    if (a.status === 'archived') return { data: a };
    await db.query(`UPDATE kb_article SET status = 'archived' WHERE id = $1`, [a.id]);
    return { data: await load(db, a.id) };
  }));

  app.post('/v1/kb/articles/:id/restore', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'approve');
    const a = await load(db, (req.params as any).id);
    if (a.status !== 'archived') throw new ApiError(409, 'bad_state', 'This article is not archived');
    await db.query(`UPDATE kb_article SET status = 'draft' WHERE id = $1`, [a.id]);
    return { data: await load(db, a.id) };
  }));

  // Shows how the text will look on the help center.
  app.post('/v1/kb/preview', async (req) => authed(req, async (db, uid) => {
    await need(kit, db, uid, 'read');
    return { html: renderMarkdown(str((req.body as any)?.body, 'body', 60000) ?? '') };
  }));
}
