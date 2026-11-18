import type { FastifyInstance, FastifyReply } from 'fastify';
import { withoutTenant, withTenant, type Db } from './db.js';
import { ApiError } from './errors.js';
import { renderMarkdown, escapeHtml as h } from './kbmd.js';

// Public, no sign in. These only ever return the approved copy of public articles, and only for a company whose
// help center has been switched on. Internal and unapproved text can not reach this code: it reads kb_article_version.
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const TYPE_LABEL: Record<string, string> = { how_to: 'How to', troubleshooting: 'Troubleshooting', faq: 'FAQ' };

type Site = { tenant_id: string; slug: string; title: string; tagline: string | null; accent: string | null };

const hits = new Map<string, { n: number; reset: number }>();
function limit(ip: string, max = 120) {
  const now = Date.now();
  const t = hits.get(ip);
  if (!t || t.reset < now) { hits.set(ip, { n: 1, reset: now + 60_000 }); if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k); return; }
  if (++t.n > max) throw new ApiError(429, 'too_many_requests', 'Too many requests. Wait a minute and try again.');
}

async function findSite(slug: string): Promise<Site> {
  if (!SLUG.test(slug)) throw new ApiError(404, 'not_found', 'Help center not found');
  const r = await withoutTenant((db) => db.query(`SELECT tenant_id, slug, title, tagline, accent FROM kb_site WHERE slug = $1 AND enabled`, [slug]));
  if (r.rowCount === 0) throw new ApiError(404, 'not_found', 'Help center not found');
  return r.rows[0];
}
const inSite = <T>(site: Site, fn: (db: Db) => Promise<T>) =>
  withTenant({ tenantId: site.tenant_id, userId: SYSTEM_USER, actorType: 'system' }, fn);

// What a visitor may see: the approved copy of articles that are public and not archived.
const LIVE = `a.deleted_at IS NULL AND a.status <> 'archived' AND a.published_version_id IS NOT NULL AND v.audience = 'public'`;
const FROM = `FROM kb_article a JOIN kb_article_version v ON v.id = a.published_version_id LEFT JOIN kb_category c ON c.id = v.category_id`;

async function listArticles(db: Db, qs: Record<string, string>) {
  const args: unknown[] = []; const where = [LIVE];
  let rank = '0::real';
  if (qs.type && TYPE_LABEL[qs.type]) { args.push(qs.type); where.push(`v.type = $${args.length}`); }
  if (qs.category && SLUG.test(qs.category)) { args.push(qs.category); where.push(`c.slug = $${args.length}`); }
  const text = (qs.q ?? '').trim().slice(0, 200);
  if (text) { args.push(text); where.push(`v.search @@ websearch_to_tsquery('english', $${args.length})`); rank = `ts_rank(v.search, websearch_to_tsquery('english', $${args.length}))`; }
  const r = await db.query(
    `SELECT a.slug, v.type, v.title, v.summary, v.tags, c.name AS category, c.slug AS category_slug, a.published_at, v.version_no
     ${FROM} WHERE ${where.join(' AND ')} ORDER BY ${rank} DESC, v.title LIMIT 100`, args);
  return r.rows;
}

async function getArticle(db: Db, slug: string, count: boolean) {
  if (!SLUG.test(slug)) throw new ApiError(404, 'not_found', 'Article not found');
  const r = await db.query(
    `SELECT a.id, a.slug, v.type, v.title, v.summary, v.body, v.tags, c.name AS category, c.slug AS category_slug, a.published_at, v.version_no
     ${FROM} WHERE ${LIVE} AND a.slug = $1`, [slug]);
  if (r.rowCount === 0) throw new ApiError(404, 'not_found', 'Article not found');
  const row = r.rows[0];
  if (count) await db.query(
    `INSERT INTO kb_stat (tenant_id, article_id, views) VALUES (current_tenant_id(), $1, 1)
     ON CONFLICT (tenant_id, article_id) DO UPDATE SET views = kb_stat.views + 1`, [row.id]);
  return row;
}

const CSS = `:root{--a:#2457c5;--bg:#fff;--ink:#1c2430;--mute:#5d6b7c;--line:#e3e8ee;--card:#f6f8fb}
@media(prefers-color-scheme:dark){:root{--bg:#12161c;--ink:#e8edf3;--mute:#97a3b3;--line:#2a323d;--card:#1a2029}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif}
a{color:var(--a)}header{border-bottom:1px solid var(--line);padding:28px 16px;background:var(--card)}
.w{max-width:760px;margin:0 auto;padding:0 16px}header .w{padding:0}h1{margin:0 0 4px;font-size:1.7rem}header p{margin:0;color:var(--mute)}
form{margin:18px 0 0;display:flex;gap:8px}input[type=search]{flex:1;padding:11px 12px;font:inherit;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
button{padding:10px 16px;font:inherit;border:0;border-radius:8px;background:var(--a);color:#fff;cursor:pointer}
main{padding:24px 0 60px}ul.l{list-style:none;padding:0;margin:0}ul.l li{padding:14px 0;border-bottom:1px solid var(--line)}
ul.l a{font-weight:600;text-decoration:none}.m{color:var(--mute);font-size:.88rem}.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 9px;font-size:.78rem;margin-right:6px}
pre{background:var(--card);padding:12px;border-radius:8px;overflow:auto}code{background:var(--card);padding:1px 5px;border-radius:4px}pre code{padding:0}
blockquote{margin:12px 0;padding:2px 14px;border-left:3px solid var(--a);color:var(--mute)}.cats a{margin-right:12px}
.vote{margin-top:36px;padding-top:16px;border-top:1px solid var(--line)}.vote button{background:var(--card);color:var(--ink);border:1px solid var(--line);margin-right:8px}`;

function page(site: Site, title: string, body: string, q = '') {
  const accent = site.accent ? `:root{--a:${site.accent}}` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}</title><style>${CSS}${accent}</style></head><body>
<header><div class="w"><h1><a href="/help/${h(site.slug)}" style="color:inherit;text-decoration:none">${h(site.title)}</a></h1>${site.tagline ? `<p>${h(site.tagline)}</p>` : ''}
<form action="/help/${h(site.slug)}" method="get" role="search"><input type="search" name="q" value="${h(q)}" placeholder="Search for help" aria-label="Search"><button>Search</button></form></div></header>
<main><div class="w">${body}</div></main></body></html>`;
}

function listHtml(site: Site, rows: any[]) {
  if (!rows.length) return '<p class="m">No articles found.</p>';
  return `<ul class="l">${rows.map((r) => `<li><a href="/help/${h(site.slug)}/${h(r.slug)}">${h(r.title)}</a>
<div class="m"><span class="tag">${TYPE_LABEL[r.type]}</span>${r.category ? h(r.category) : ''}</div>${r.summary ? `<div>${h(r.summary)}</div>` : ''}</li>`).join('')}</ul>`;
}

export function kbPublicRoutes(app: FastifyInstance) {
  const html = (reply: FastifyReply, code: number, s: string) => reply.status(code).type('text/html; charset=utf-8').header('X-Content-Type-Options', 'nosniff').send(s);

  // ---- open JSON feed. Anyone's website can read it.
  const cors = (reply: FastifyReply) => reply.header('Access-Control-Allow-Origin', '*').header('Cache-Control', 'public, max-age=60');
  app.get('/public/v1/kb/:slug', async (req, reply) => {
    limit(req.ip);
    const site = await findSite((req.params as any).slug);
    const cats = await inSite(site, (db) => db.query(
      `SELECT c.name, c.slug, c.description, count(*)::int AS articles ${FROM} WHERE ${LIVE} AND c.id IS NOT NULL GROUP BY c.id ORDER BY c.sort_order, c.name`));
    return cors(reply).send({ site: { slug: site.slug, title: site.title, tagline: site.tagline }, categories: cats.rows });
  });

  app.get('/public/v1/kb/:slug/articles', async (req, reply) => {
    limit(req.ip);
    const site = await findSite((req.params as any).slug);
    const rows = await inSite(site, (db) => listArticles(db, req.query as any));
    return cors(reply).send({ data: rows });
  });

  app.get('/public/v1/kb/:slug/articles/:article', async (req, reply) => {
    limit(req.ip);
    const p = req.params as any;
    const site = await findSite(p.slug);
    const a = await inSite(site, (db) => getArticle(db, p.article, true));
    const { id: _id, ...rest } = a;
    return cors(reply).send({ data: { ...rest, html: renderMarkdown(a.body) } });
  });

  app.options('/public/v1/kb/*', async (_req, reply) =>
    reply.status(204).header('Access-Control-Allow-Origin', '*').header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS').header('Access-Control-Allow-Headers', 'content-type').send());

  app.post('/public/v1/kb/:slug/articles/:article/vote', async (req, reply) => {
    limit(req.ip, 20);
    const p = req.params as any;
    const yes = (req.body as any)?.helpful;
    if (typeof yes !== 'boolean') throw new ApiError(400, 'bad_request', 'helpful must be true or false');
    const site = await findSite(p.slug);
    await inSite(site, async (db) => {
      const a = await getArticle(db, p.article, false);
      await db.query(
        `INSERT INTO kb_stat (tenant_id, article_id, helpful_yes, helpful_no) VALUES (current_tenant_id(), $1, $2, $3)
         ON CONFLICT (tenant_id, article_id) DO UPDATE SET helpful_yes = kb_stat.helpful_yes + $2, helpful_no = kb_stat.helpful_no + $3`,
        [a.id, yes ? 1 : 0, yes ? 0 : 1]);
    });
    return cors(reply).send({ ok: true });
  });

  // ---- hosted pages
  app.get('/help/:slug', async (req, reply) => {
    limit(req.ip);
    const site = await findSite((req.params as any).slug);
    const qs = req.query as Record<string, string>;
    const { rows, cats } = await inSite(site, async (db) => ({
      rows: await listArticles(db, qs),
      cats: (await db.query(`SELECT c.name, c.slug ${FROM} WHERE ${LIVE} AND c.id IS NOT NULL GROUP BY c.id ORDER BY c.sort_order, c.name`)).rows,
    }));
    const nav = cats.length && !qs.q ? `<p class="cats">${cats.map((c: any) => `<a href="/help/${h(site.slug)}?category=${h(c.slug)}">${h(c.name)}</a>`).join('')}</p>` : '';
    const head = qs.q ? `<h2>Results for “${h(qs.q.slice(0, 100))}”</h2>` : '';
    return html(reply, 200, page(site, site.title, nav + head + listHtml(site, rows), qs.q ?? ''));
  });

  app.get('/help/:slug/:article', async (req, reply) => {
    limit(req.ip);
    const p = req.params as any;
    const site = await findSite(p.slug);
    const a = await inSite(site, (db) => getArticle(db, p.article, true));
    const body = `<p class="m"><a href="/help/${h(site.slug)}">All articles</a> · <span class="tag">${TYPE_LABEL[a.type]}</span>${a.category ? h(a.category) : ''}</p>
<h2 style="font-size:1.9rem;margin:.3em 0">${h(a.title)}</h2>${a.summary ? `<p class="m">${h(a.summary)}</p>` : ''}${renderMarkdown(a.body)}
<div class="vote" id="vote"><strong>Was this helpful?</strong><p><button data-v="1">Yes</button><button data-v="0">No</button></p></div>
<script>document.getElementById('vote').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;
fetch('/public/v1/kb/${h(site.slug)}/articles/${h(a.slug)}/vote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({helpful:b.dataset.v==='1'})});
this.innerHTML='<strong>Thanks for the feedback.</strong>';});</script>`;
    return html(reply, 200, page(site, `${a.title} · ${site.title}`, body));
  });
}
