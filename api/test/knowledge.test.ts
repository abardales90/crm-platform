import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, type World } from './harness.js';
import { renderMarkdown } from '../src/kbmd.js';

let w: World;
beforeAll(async () => { w = await setup(); }, 60_000);
afterAll(async () => { await w?.teardown(); });
const A = (u = 'admin') => w.as('a', u);
const B = (u = 'admin') => w.as('b', u);

async function article(h: any, over: Record<string, unknown> = {}) {
  const r = await w.call('POST', '/v1/kb/articles', h, { type: 'how_to', title: 'Reset your password', body: 'Click **Forgot password**.', ...over });
  expect(r.status).toBe(200);
  return r.body.data;
}
async function publish(id: string, author = A('agent'), approver = A('admin')) {
  expect((await w.call('POST', `/v1/kb/articles/${id}/submit`, author)).status).toBe(200);
  return w.call('POST', `/v1/kb/articles/${id}/approve`, approver, {});
}

describe('knowledge base', () => {
  it('a rep can draft, and the draft is not public', async () => {
    const a = await article(A('agent'), { title: 'Draft only' });
    expect(a.status).toBe('draft');
    expect(a.slug).toBe('draft-only');
    await w.call('PUT', '/v1/kb/site', A(), { slug: 'acme', title: 'Acme Help', enabled: true });
    const r = await w.call('GET', '/public/v1/kb/acme/articles', {});
    expect(r.body.data.find((x: any) => x.slug === 'draft-only')).toBeUndefined();
    expect((await w.call('GET', '/public/v1/kb/acme/articles/draft-only', {})).status).toBe(404);
  });

  it('review: a second person approves, then it is public with a frozen copy', async () => {
    const a = await article(A('agent'), { title: 'Fix login loop' });
    expect((await w.call('POST', `/v1/kb/articles/${a.id}/approve`, A('admin'), {})).status).toBe(409); // not submitted
    const ok = await publish(a.id);
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('published');
    const pub = await w.call('GET', '/public/v1/kb/acme/articles/fix-login-loop', {});
    expect(pub.status).toBe(200);
    expect(pub.body.data.html).toContain('<strong>Forgot password</strong>');
    expect(pub.body.data.id).toBeUndefined();
  });

  it('editing a live article keeps the approved text public until the edit is approved', async () => {
    const a = await article(A('agent'), { title: 'Change plan', body: 'old text' });
    await publish(a.id);
    const e = await w.call('PATCH', `/v1/kb/articles/${a.id}`, A('agent'), { body: 'new text', version: (await w.call('GET', `/v1/kb/articles/${a.id}`, A())).body.data.version });
    expect(e.body.data.status).toBe('draft');
    expect((await w.call('GET', '/public/v1/kb/acme/articles/change-plan', {})).body.data.body).toBe('old text');
    await publish(a.id);
    expect((await w.call('GET', '/public/v1/kb/acme/articles/change-plan', {})).body.data.body).toBe('new text');
    expect((await w.call('GET', `/v1/kb/articles/${a.id}`, A())).body.data.history.length).toBe(2);
  });

  it('internal articles never appear publicly, even when published', async () => {
    const a = await article(A('agent'), { title: 'Refund override codes', audience: 'internal', body: 'secret steps' });
    await publish(a.id);
    expect((await w.call('GET', '/public/v1/kb/acme/articles/refund-override-codes', {})).status).toBe(404);
    const list = await w.call('GET', '/public/v1/kb/acme/articles', {});
    expect(JSON.stringify(list.body)).not.toContain('secret steps');
    expect(JSON.stringify(list.body)).not.toContain('Refund override');
    expect((await w.call('GET', '/v1/kb/articles?audience=internal', A('agent'))).body.data.length).toBe(1);
  });

  it('permissions: agents cannot approve; same person cannot approve their own unless admin', async () => {
    const a = await article(A('agent'), { title: 'Agent article' });
    await w.call('POST', `/v1/kb/articles/${a.id}/submit`, A('agent'));
    expect((await w.call('POST', `/v1/kb/articles/${a.id}/approve`, A('agent'), {})).status).toBe(403);
    expect((await w.call('PUT', '/v1/kb/site', A('agent'), { slug: 'x1', title: 'x' })).status).toBe(403);
    const mine = await article(A('admin'), { title: 'Admin article' });
    await w.call('POST', `/v1/kb/articles/${mine.id}/submit`, A('admin'));
    expect((await w.call('POST', `/v1/kb/articles/${mine.id}/approve`, A('admin'), {})).status).toBe(200); // admin override
  });

  it('reject sends it back with a note, archive hides it at once', async () => {
    const a = await article(A('agent'), { title: 'Needs work' });
    await w.call('POST', `/v1/kb/articles/${a.id}/submit`, A('agent'));
    expect((await w.call('POST', `/v1/kb/articles/${a.id}/reject`, A('admin'), {})).status).toBe(400); // note required
    const r = await w.call('POST', `/v1/kb/articles/${a.id}/reject`, A('admin'), { note: 'Add screenshots' });
    expect(r.body.data.status).toBe('draft');
    expect(r.body.data.review_note).toBe('Add screenshots');
    const b = await article(A('agent'), { title: 'Soon gone' });
    await publish(b.id);
    expect((await w.call('GET', '/public/v1/kb/acme/articles/soon-gone', {})).status).toBe(200);
    await w.call('POST', `/v1/kb/articles/${b.id}/archive`, A('admin'));
    expect((await w.call('GET', '/public/v1/kb/acme/articles/soon-gone', {})).status).toBe(404);
  });

  it('companies are fully separate', async () => {
    await w.call('PUT', '/v1/kb/site', B(), { slug: 'bravo', title: 'Bravo Help', enabled: true });
    expect((await w.call('PUT', '/v1/kb/site', B(), { slug: 'acme', title: 'x' })).status).toBe(409);
    expect((await w.call('GET', '/v1/kb/articles', B())).body.data.length).toBe(0);
    expect((await w.call('GET', '/public/v1/kb/bravo/articles', {})).body.data.length).toBe(0);
    expect((await w.call('GET', '/public/v1/kb/bravo/articles/fix-login-loop', {})).status).toBe(404);
    const aId = (await w.call('GET', '/v1/kb/articles', A('admin'))).body.data[0].id;
    expect((await w.call('GET', `/v1/kb/articles/${aId}`, B())).status).toBe(404);
    expect((await w.call('PATCH', `/v1/kb/articles/${aId}`, B(), { title: 'hijack' })).status).toBe(404);
    expect((await w.call('GET', '/v1/kb/site', B())).body.data.slug).toBe('bravo');
  });

  it('a switched off help center is not found', async () => {
    await w.call('PUT', '/v1/kb/site', B(), { slug: 'bravo', title: 'Bravo Help', enabled: false });
    expect((await w.call('GET', '/public/v1/kb/bravo/articles', {})).status).toBe(404);
    expect((await w.call('GET', '/help/bravo', {})).status).toBe(404);
    expect((await w.call('GET', '/public/v1/kb/nope', {})).status).toBe(404);
  });

  it('search finds by words, and hosted pages escape html', async () => {
    const a = await article(A('agent'), { title: 'Printer offline', body: 'Restart the <script>alert(1)</script> spooler', tags: ['Printing'] });
    await publish(a.id);
    const s = await w.call('GET', '/public/v1/kb/acme/articles?q=spooler', {});
    expect(s.body.data.map((x: any) => x.slug)).toContain('printer-offline');
    const page = await w.app.inject({ method: 'GET', url: '/help/acme/printer-offline' });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('<script>alert(1)');
    expect(page.body).toContain('&lt;script&gt;');
    expect(page.headers['content-type']).toContain('text/html');
    const home = await w.app.inject({ method: 'GET', url: '/help/acme?q=printer' });
    expect(home.body).toContain('Printer offline');
  });

  it('counts views and helpful votes', async () => {
    await w.call('POST', '/public/v1/kb/acme/articles/printer-offline/vote', {}, { helpful: true });
    expect((await w.call('POST', '/public/v1/kb/acme/articles/printer-offline/vote', {}, { helpful: 'maybe' })).status).toBe(400);
    const row = (await w.call('GET', '/v1/kb/articles', A())).body.data.find((x: any) => x.slug === 'printer-offline');
    expect(row.views).toBeGreaterThanOrEqual(1);
    expect(row.helpful_yes).toBe(1);
  });

  it('rejects bad input and stale edits', async () => {
    expect((await w.call('POST', '/v1/kb/articles', A(), { type: 'novel', title: 'x' })).status).toBe(400);
    expect((await w.call('POST', '/v1/kb/articles', A(), { type: 'faq', title: 'x', tags: Array(16).fill('a').map((x, i) => x + i) })).status).toBe(400);
    const a = await article(A(), { title: 'Stale test' });
    expect((await w.call('PATCH', `/v1/kb/articles/${a.id}`, A(), { title: 'n', version: a.version + 5 })).status).toBe(409);
    expect((await w.call('GET', '/v1/kb/articles', w.as('a', 'finance'))).status).toBe(403);
    expect((await w.call('GET', '/v1/kb/articles', {})).status).toBe(401);
  });

  it('categories group public articles and appear in the backup', async () => {
    const c = (await w.call('POST', '/v1/kb/categories', A(), { name: 'Getting started' })).body.data;
    expect(c.slug).toBe('getting-started');
    const a = await article(A('agent'), { title: 'First steps', category_id: c.id });
    await publish(a.id);
    const feed = await w.call('GET', '/public/v1/kb/acme', {});
    expect(feed.body.categories[0].slug).toBe('getting-started');
    expect((await w.call('GET', '/public/v1/kb/acme/articles?category=getting-started', {})).body.data.length).toBe(1);
    const bk = await w.call('GET', '/v1/settings/backup', A());
    expect(bk.body.tables.kb_article.length).toBeGreaterThan(5);
    expect(bk.body.tables.kb_site.length).toBe(1);
  });
});

describe('markdown renderer', () => {
  it('escapes html and blocks unsafe links', () => {
    const h = renderMarkdown('# Hi\n\n[x](javascript:alert(1)) <img src=x onerror=1>\n\n- a\n- b\n\n1. one');
    expect(h).toContain('<h2>Hi</h2>');
    expect(h).not.toContain('<a href="javascript');
    expect(h).not.toContain('<img');
    expect(h).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(h).toContain('<ol><li>one</li></ol>');
  });
});
