import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, type World } from './harness.js';

let w: World;
beforeAll(async () => { w = await setup(); }, 60_000);
afterAll(async () => { await w?.teardown(); });

const A = (u = 'admin') => w.as('a', u);
const B = (u = 'admin') => w.as('b', u);

describe('search', () => {
  beforeAll(async () => {
    const acct = (await w.call('POST', '/v1/accounts', A(), { name: 'Northwind Traders', domain: 'northwind.test' })).body;
    await w.call('POST', '/v1/accounts', A(), { name: '100% Pure_Water' });
    await w.call('POST', '/v1/contacts', A(), { first_name: 'Nora', last_name: 'Northcott', email: 'nora@northwind.test', account_id: acct.id });
    const queue = (await w.call('GET', '/v1/queues', A())).body.data[0].id;
    await w.call('POST', '/v1/cases', A(), { subject: 'Northern route is down', queue_id: queue, priority: 'high' });
    await w.call('POST', '/v1/accounts', B(), { name: 'Northstar Secret Co' });
  }, 60_000);

  const find = async (q: string, who = A()) => (await w.call('GET', `/v1/search?q=${encodeURIComponent(q)}`, who));
  const keys = (r: any) => r.body.groups.map((g: any) => g.key);

  it('finds records of every kind from part of a word, ignoring capitals', async () => {
    const r = await find('NORTH');
    expect(r.status).toBe(200);
    expect(keys(r)).toEqual(expect.arrayContaining(['accounts', 'contacts', 'cases']));
    const acc = r.body.groups.find((g: any) => g.key === 'accounts').rows;
    expect(acc.map((x: any) => x.title)).toContain('Northwind Traders');
    expect(r.body.groups.find((g: any) => g.key === 'contacts').rows[0]).toMatchObject({ title: 'Nora Northcott', sub: 'nora@northwind.test' });
  });

  it('finds a person by email and a case by its number', async () => {
    expect(keys(await find('nora@northwind'))).toEqual(['contacts']);
    const c = await find('#1');
    expect(keys(c)).toContain('cases');
  });

  it('needs at least two letters', async () => {
    expect((await find('n')).body.groups).toEqual([]);
    expect((await find('')).body.groups).toEqual([]);
  });

  it('treats percent and underscore as plain characters', async () => {
    expect((await find('%%')).body.groups).toEqual([]);
    const r = await find('100%');
    expect(r.body.groups[0].rows.map((x: any) => x.title)).toEqual(['100% Pure_Water']);
    expect((await find('Pure_W')).body.groups[0].rows).toHaveLength(1);
    expect((await find('Pure_X')).body.groups).toEqual([]);
  });

  it('never shows another company\'s records', async () => {
    expect(JSON.stringify((await find('Northstar')).body)).not.toContain('Northstar Secret');
    expect(keys(await find('Northstar', B()))).toEqual(['accounts']);
  });

  it('skips kinds the person cannot read', async () => {
    for (const who of ['agent', 'sales', 'finance']) {
      const me = (await w.call('GET', '/v1/me', A(who))).body.permissions;
      const r = await find('north', A(who));
      expect(r.status).toBe(200);
      const allowed = { accounts: 'account', contacts: 'contact', deals: 'opportunity', cases: 'case' } as Record<string, string>;
      for (const k of keys(r)) expect(me[allowed[k]]).toContain('read');
    }
  });

  it('needs a signed in user', async () => {
    expect((await w.call('GET', '/v1/search?q=north', {})).status).toBe(401);
  });
});

describe('search: inside notes, previews and labels', () => {
  let acct: any, caseId: string;
  const find = (q: string, who = A(), extra = '') => w.call('GET', `/v1/search?q=${encodeURIComponent(q)}${extra}`, who);
  const group = (r: any, key: string) => r.body.groups.find((g: any) => g.key === key);

  beforeAll(async () => {
    acct = (await w.call('POST', '/v1/accounts', A(), { name: 'Stark Industries', description: 'Big renewal talks. The champion is Pepper Potts and she wants onboarding help before March.' })).body;
    const tony = (await w.call('POST', '/v1/contacts', A(), { first_name: 'Tony', last_name: 'Stark', email: 'tony@stark.test', account_id: acct.id, description: 'Secret handshake word is zanzibar' })).body;
    const queue = (await w.call('GET', '/v1/queues', A())).body.data[0].id;
    const c = (await w.call('POST', '/v1/cases', A(), { subject: 'Login trouble', description: 'Tony Camillo cannot log in since the update went out on Tuesday.', queue_id: queue, priority: 'high', contact_id: tony.id })).body;
    caseId = c.id;
    await w.call('POST', '/v1/case-comments', A(), { case_id: c.id, body: 'Asked Camillo to clear the browser cache', is_public: false, author_user_id: w.tenants.a.users.admin });
    await w.call('POST', '/v1/activities', A(), { type: 'task', subject: 'Call Camillo back', body: 'Offer a screen share', case_id: c.id });
  }, 60_000);

  it('finds a case from words inside its description and shows where the match is', async () => {
    const r = await find('Camillo');
    const row = group(r, 'cases').rows[0];
    expect(row.id).toBe(caseId);
    expect(row.matched).toBe('Description');
    expect(row.snippet).toContain('Tony Camillo cannot log in');
    // the contact Tony Stark does not contain Camillo anywhere
    expect(group(r, 'contacts')).toBeUndefined();
  });

  it('needs every word, in any order, and can find one person by first and last name', async () => {
    expect(group(await find('Tony Camillo'), 'cases')).toBeTruthy();
    expect(group(await find('Tony Camillo'), 'contacts')).toBeUndefined();
    expect(group(await find('stark tony'), 'contacts').rows[0].title).toBe('Tony Stark');
    expect((await find('Tony Nobody')).body.groups).toEqual([]);
  });

  it('shows a short preview of notes on accounts and contacts, with the match inside it', async () => {
    const a = group(await find('Pepper'), 'accounts').rows[0];
    expect(a).toMatchObject({ title: 'Stark Industries', matched: 'Notes' });
    expect(a.snippet).toContain('Pepper Potts');
    expect(a.snippet.length).toBeLessThan(200);
    expect(group(await find('zanzibar'), 'contacts').rows[0].matched).toBe('Notes');
  });

  it('finds tasks and case replies and points at the record they belong to', async () => {
    const r = await find('Camillo');
    const task = group(r, 'activities').rows[0];
    expect(task).toMatchObject({ title: 'Call Camillo back', href: 'cases', id: caseId, sub: 'task' });
    const reply = group(r, 'replies').rows[0];
    expect(reply).toMatchObject({ href: 'cases', id: caseId, matched: 'Message' });
    expect(reply.title).toMatch(/^Reply on case #\d+$/);
    expect(group(await find('screen share'), 'activities').rows[0].matched).toBe('Details');
  });

  it('can limit the kinds searched and the number of rows', async () => {
    const r = await find('Camillo', A(), '&types=cases,replies');
    expect(r.body.groups.map((g: any) => g.key).sort()).toEqual(['cases', 'replies']);
    for (let i = 0; i < 4; i++) await w.call('POST', '/v1/accounts', A(), { name: `Limit Test ${i}` });
    expect(group(await find('Limit Test', A(), '&limit=2'), 'accounts').rows).toHaveLength(2);
  });

  it('puts a heading match first and hides fields the person may not see', async () => {
    const rows = group(await find('stark'), 'accounts').rows;
    expect(rows[0].title).toBe('Stark Industries');
    await w.sql(`INSERT INTO field_permission (tenant_id, role_id, object, field, access) VALUES ($1, $2, 'contact', 'description', 'none')`, [w.tenants.a.id, w.tenants.a.roles['Support Agent']]);
    const me = (await w.call('GET', '/v1/me', A('agent'))).body.permissions;
    expect(me.contact).toContain('read');
    expect(group(await find('zanzibar', A('agent')), 'contacts')).toBeUndefined();
    expect(group(await find('zanzibar'), 'contacts')).toBeTruthy();
  });
});

describe('menu preferences', () => {
  const put = (b: unknown, who = A()) => w.call('PUT', '/v1/me/preferences', who, b);
  it('starts with the standard menu, saves an order and the collapsed state, and can reset', async () => {
    const first = (await w.call('GET', '/v1/me/preferences', A('sales'))).body;
    expect(first.nav_order).toBeNull();
    expect(first.nav_collapsed).toBe(false);
    const r = await put({ nav_order: ['cases', 'home', 'accounts'], nav_collapsed: true }, A('sales'));
    expect(r.body).toMatchObject({ nav_order: ['cases', 'home', 'accounts'], nav_collapsed: true });
    expect((await w.call('GET', '/v1/me/preferences', A('sales'))).body.nav_order).toEqual(['cases', 'home', 'accounts']);
    expect((await put({ nav_order: null }, A('sales'))).body.nav_order).toBeNull();
  });
  it('is saved per person and per company', async () => {
    await put({ nav_order: ['reports', 'home'] }, A('agent'));
    expect((await w.call('GET', '/v1/me/preferences', A('finance'))).body.nav_order).toBeNull();
    expect((await w.call('GET', '/v1/me/preferences', B('agent'))).body.nav_order).toBeNull();
  });
  it('refuses a bad order', async () => {
    for (const bad of [[], ['home', 'home'], ['Home'], ['home', 'a b'], ['<script>'], 'home', Array.from({ length: 13 }, (_, i) => 'x' + String.fromCharCode(97 + i)), [1, 2]]) {
      expect((await put({ nav_order: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await put({ nav_collapsed: 'yes' })).status).toBe(400);
  });
});

describe('bulk import', () => {
  const imp = (path: string, body: unknown, who = A()) => w.call('POST', `/v1/${path}/import`, who, body);

  it('imports accounts and gives the caller as owner when none is sent', async () => {
    const r = await imp('accounts', { rows: [{ name: 'Imp One', domain: 'one.test', type: 'customer' }, { name: 'Imp Two', annual_revenue: 5000, number_of_employees: 12 }] });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ created: 2, skipped: 0 });
    const list = (await w.call('GET', '/v1/accounts', A())).body.data.filter((a: any) => a.name.startsWith('Imp '));
    expect(list).toHaveLength(2);
    expect(list.every((a: any) => a.owner_user_id === w.tenants.a.users.admin)).toBe(true);
  });

  it('is all or nothing, and names the row and the reason for each problem', async () => {
    const r = await imp('accounts', { rows: [{ name: 'Should Not Exist' }, { type: 'customer' }, { name: 'Bad Type', type: 'whale' }, { name: 'Dupe', domain: 'one.test' }] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('import_failed');
    const errs = r.body.error.details.errors;
    expect(errs.map((e: any) => e.row)).toEqual([2, 3, 4]);
    expect(errs[2].message).toMatch(/same domain/);
    const names = (await w.call('GET', '/v1/accounts', A())).body.data.map((a: any) => a.name);
    expect(names).not.toContain('Should Not Exist');
  });

  it('can skip rows that already exist and says how many', async () => {
    const r = await imp('accounts', { skip_duplicates: true, rows: [{ name: 'Imp One again', domain: 'one.test' }, { name: 'Imp Three', domain: 'three.test' }] });
    expect(r.body).toEqual({ created: 1, skipped: 1 });
  });

  it('imports contacts, links them to an account, and refuses an upper case email', async () => {
    const acct = (await w.call('GET', '/v1/accounts', A())).body.data.find((a: any) => a.name === 'Imp One');
    const ok = await imp('contacts', { rows: [{ last_name: 'Lee', first_name: 'Ann', email: 'ann@one.test', account_id: acct.id }] });
    expect(ok.body.created).toBe(1);
    const bad = await imp('contacts', { rows: [{ last_name: 'Shouty', email: 'LOUD@one.test' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.errors[0].row).toBe(1);
  });

  it('rejects unknown, system and made up fields row by row', async () => {
    const r = await imp('accounts', { rows: [{ name: 'X1', id: '00000000-0000-0000-0000-000000000001' }, { name: 'X2', tenant_id: w.tenants.b.id }, { name: 'X3', nonsense: 1 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.details.errors.map((e: any) => e.row)).toEqual([1, 2, 3]);
  });

  it('cannot attach a contact to an account in another company', async () => {
    const other = (await w.call('POST', '/v1/accounts', B(), { name: 'Other Tenant Acct' })).body;
    const r = await imp('contacts', { rows: [{ last_name: 'Sneaky', account_id: other.id }] });
    expect(r.status).toBe(422);
  });

  it('checks the input and the size', async () => {
    expect((await imp('accounts', {})).status).toBe(400);
    expect((await imp('accounts', { rows: [] })).status).toBe(400);
    const big = await imp('accounts', { rows: Array.from({ length: 501 }, (_, i) => ({ name: 'n' + i })) });
    expect(big.status).toBe(400);
    expect(big.body.error.code).toBe('too_many_rows');
  });

  it('handles the biggest allowed batch', async () => {
    const r = await imp('accounts', { rows: Array.from({ length: 500 }, (_, i) => ({ name: 'Bulk ' + i })) });
    expect(r.body.created).toBe(500);
  }, 30_000);

  it('needs permission to create', async () => {
    for (const who of ['agent', 'finance']) {
      const me = (await w.call('GET', '/v1/me', A(who))).body.permissions;
      const r = await imp('accounts', { rows: [{ name: 'Nope ' + who }] }, A(who));
      expect(r.status).toBe(me.account.includes('create') ? 201 : 403);
    }
  });

  it('respects hidden fields', async () => {
    const r = await imp('accounts', { rows: [{ name: 'Peek', annual_revenue: 1 }] }, A('agent'));
    expect([403, 422]).toContain(r.status);
  });

  it('needs a signed in user', async () => {
    expect((await w.call('POST', '/v1/accounts/import', {}, { rows: [{ name: 'x' }] })).status).toBe(401);
  });
});

describe('screen files', () => {
  it('are always checked for a newer copy, so an update shows up on the next visit', async () => {
    const r = await w.app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200); // the shared test app serves no screens, so build one that does
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { buildApp } = await import('../src/app.js');
    const dir = mkdtempSync(join(tmpdir(), 'ui-'));
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    const ui = buildApp({ jwtSecret: 'x'.repeat(40), uiDir: dir });
    await ui.ready();
    const first = await ui.inject({ method: 'GET', url: '/app.js' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-cache');
    expect(first.headers.etag).toBeTruthy();
    const again = await ui.inject({ method: 'GET', url: '/app.js', headers: { 'if-none-match': String(first.headers.etag) } });
    expect(again.statusCode).toBe(304);
    await ui.close();
  });
});

describe('custom fields', () => {
  const mk = async (body: any, who = A()) => w.call('POST', '/v1/settings/custom-fields', who, body);
  let planId = '';

  it('lets an admin add fields of each kind and makes a key from the name', async () => {
    const t = await mk({ object: 'account', label: 'Contract Tier', kind: 'pick one', options: ['Gold', 'Silver', ' Gold '], required: false });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ key: 'contract_tier', kind: 'pick one', options: ['Gold', 'Silver'] });
    planId = t.body.id;
    for (const [label, kind] of [['Seats', 'number'], ['Go live', 'date'], ['Strategic', 'checkbox'], ['Blurb', 'long text'], ['Nickname', 'text']])
      expect((await mk({ object: 'account', label, kind })).status).toBe(201);
    const list = (await w.call('GET', '/v1/settings/custom-fields', A('agent'))).body.data;
    expect(list.filter((f: any) => f.object === 'account').map((f: any) => f.key)).toEqual(['contract_tier', 'seats', 'go_live', 'strategic', 'blurb', 'nickname']);
  });

  it('only admins change them, and other companies never see them', async () => {
    expect((await mk({ object: 'account', label: 'Sneaky', kind: 'text' }, A('sales'))).status).toBe(403);
    expect((await w.call('PATCH', `/v1/settings/custom-fields/${planId}`, A('agent'), { label: 'x' })).status).toBe(403);
    expect((await w.call('GET', '/v1/settings/custom-fields', B())).body.data).toEqual([]);
    expect((await w.call('PATCH', `/v1/settings/custom-fields/${planId}`, B(), { label: 'x' })).status).toBe(404);
  });

  it('refuses bad definitions and repeated names', async () => {
    expect((await mk({ object: 'lead', label: 'A', kind: 'text' })).status).toBe(400);
    expect((await mk({ object: 'account', label: 'A', kind: 'color' })).status).toBe(400);
    expect((await mk({ object: 'account', label: '   ', kind: 'text' })).status).toBe(400);
    expect((await mk({ object: 'account', label: '123', kind: 'text' })).status).toBe(400);
    expect((await mk({ object: 'account', label: 'Pick', kind: 'pick one', options: [] })).status).toBe(400);
    expect((await mk({ object: 'account', label: 'seats', kind: 'text' })).status).toBe(409);
  });

  it('saves values on records, checks each kind, and merges on update', async () => {
    const ok = await w.call('POST', '/v1/accounts', A(), { name: 'Custom Co', custom: { contract_tier: 'Gold', seats: 12, go_live: '2026-11-01', strategic: true, nickname: 'CC' } });
    expect(ok.status).toBe(201);
    expect(ok.body.custom).toMatchObject({ contract_tier: 'Gold', seats: 12, strategic: true });
    const bad = async (custom: any) => (await w.call('POST', '/v1/accounts', A(), { name: 'Bad', custom })).status;
    expect(await bad({ contract_tier: 'Bronze' })).toBe(400);
    expect(await bad({ seats: '12' })).toBe(400);
    expect(await bad({ go_live: '11/01/2026' })).toBe(400);
    expect(await bad({ strategic: 'yes' })).toBe(400);
    expect(await bad({ nope: 1 })).toBe(400);
    expect(await bad([])).toBe(400);
    const up = await w.call('PATCH', `/v1/accounts/${ok.body.id}`, A(), { version: ok.body.version, custom: { seats: 20, nickname: null } });
    expect(up.status).toBe(200);
    expect(up.body.custom).toEqual({ contract_tier: 'Gold', seats: 20, go_live: '2026-11-01', strategic: true });
  });

  it('can require a field, and the same field is not on other record types', async () => {
    const f = await mk({ object: 'contact', label: 'Region', kind: 'pick one', options: ['East', 'West'], required: true });
    expect((await w.call('POST', '/v1/contacts', A(), { last_name: 'NoRegion' })).status).toBe(400);
    const c = await w.call('POST', '/v1/contacts', A(), { last_name: 'Reg', custom: { region: 'East' } });
    expect(c.status).toBe(201);
    expect((await w.call('PATCH', `/v1/contacts/${c.body.id}`, A(), { version: c.body.version, custom: { region: null } })).status).toBe(400);
    expect((await w.call('POST', '/v1/accounts', A(), { name: 'Other type', custom: { region: 'East' } })).status).toBe(400);
    const imp = await w.call('POST', '/v1/contacts/import', A(), { rows: [{ last_name: 'A', custom: { region: 'West' } }, { last_name: 'B' }] });
    expect(imp.status).toBe(422);
    expect(imp.body.error.details.errors).toEqual([{ row: 2, message: 'Region is required' }]);
    await w.call('DELETE', `/v1/settings/custom-fields/${f.body.id}`, A());
    expect((await w.call('POST', '/v1/contacts', A(), { last_name: 'Free' })).status).toBe(201);
  });

  it('renames and changes choices but never the key or kind, and removing keeps saved values', async () => {
    const r = await w.call('PATCH', `/v1/settings/custom-fields/${planId}`, A(), { label: 'Tier', options: ['Gold', 'Silver', 'Bronze'], key: 'x', kind: 'text' });
    expect(r.body).toMatchObject({ key: 'contract_tier', kind: 'pick one', label: 'Tier', options: ['Gold', 'Silver', 'Bronze'] });
    const acc = (await w.call('POST', '/v1/accounts', A(), { name: 'Keeps', custom: { contract_tier: 'Bronze' } })).body;
    expect((await w.call('DELETE', `/v1/settings/custom-fields/${planId}`, A())).status).toBe(204);
    expect((await w.call('GET', `/v1/accounts/${acc.id}`, A())).body.custom.contract_tier).toBe('Bronze');
    expect((await w.call('POST', '/v1/accounts', A(), { name: 'Late', custom: { contract_tier: 'Gold' } })).status).toBe(400);
    expect((await mk({ object: 'account', label: 'Contract Tier', kind: 'text' })).status).toBe(409);
  });

  it('allows at most 20 per record type', async () => {
    let last = 201;
    for (let i = 0; i < 20 && last === 201; i++) last = (await mk({ object: 'case', label: 'Field ' + String.fromCharCode(97 + i), kind: 'text' })).status;
    expect(last).toBe(201);
    expect((await mk({ object: 'case', label: 'One more', kind: 'text' })).status).toBe(400);
  });
});

describe('saved views', () => {
  const mk = (body: any, who = A()) => w.call('POST', '/v1/views', who, body);
  const list = async (object: string, who = A()) => (await w.call('GET', `/v1/views?object=${object}`, who)).body.data;
  const flt = { search: 'north', conditions: [{ field: 'type', op: 'is', value: 'customer' }, { field: 'owner_user_id', op: 'is', value: '@me' }] };
  let mine = '';

  it('saves a view and gives it back, marked as mine', async () => {
    const r = await mk({ object: 'accounts', name: 'My customers', filter: flt });
    expect(r.status).toBe(201);
    mine = r.body.id;
    const got = (await list('accounts'))[0];
    expect(got).toMatchObject({ name: 'My customers', mine: true, is_shared: false, filter: flt });
  });

  it('keeps private views private, and shows shared ones to everyone in the company', async () => {
    expect(await list('accounts', A('sales'))).toEqual([]);
    const sh = await mk({ object: 'accounts', name: 'Team list', filter: { conditions: [] }, is_shared: true });
    const seen = await list('accounts', A('sales'));
    expect(seen.map((v: any) => v.name)).toEqual(['Team list']);
    expect(seen[0].mine).toBe(false);
    expect(await list('accounts', B())).toEqual([]);
    expect(sh.status).toBe(201);
  });

  it('lets only the owner change or remove a view', async () => {
    const shared = (await list('accounts', A('sales')))[0].id;
    expect((await w.call('PATCH', `/v1/views/${shared}`, A('sales'), { name: 'Hijack' })).status).toBe(403);
    expect((await w.call('DELETE', `/v1/views/${shared}`, A('sales'))).status).toBe(403);
    expect((await w.call('PATCH', `/v1/views/${mine}`, A('sales'), { name: 'x' })).status).toBe(404);
    expect((await w.call('PATCH', `/v1/views/${mine}`, B(), { name: 'x' })).status).toBe(404);
    const up = await w.call('PATCH', `/v1/views/${mine}`, A(), { name: 'Customers I own', is_shared: true });
    expect(up.body).toMatchObject({ name: 'Customers I own', is_shared: true });
    expect((await w.call('DELETE', `/v1/views/${shared}`, A())).status).toBe(204);
    expect((await list('accounts', A('sales'))).map((v: any) => v.name)).toEqual(['Customers I own']);
  });

  it('refuses repeated names, bad filters and records the person cannot read', async () => {
    expect((await mk({ object: 'accounts', name: ' customers i OWN ' })).status).toBe(409);
    expect((await mk({ object: 'leads', name: 'x' })).status).toBe(400);
    expect((await mk({ object: 'cases', name: '' })).status).toBe(400);
    expect((await mk({ object: 'cases', name: 'a', filter: { conditions: [{ field: 'status', op: 'drop table', value: 1 }] } })).status).toBe(400);
    expect((await mk({ object: 'cases', name: 'b', filter: { conditions: [{ field: 'status; --', op: 'is', value: 'x' }] } })).status).toBe(400);
    expect((await mk({ object: 'cases', name: 'c', filter: { conditions: [{ field: 'status', op: 'is', value: { a: 1 } }] } })).status).toBe(400);
    expect((await mk({ object: 'cases', name: 'd', filter: { conditions: new Array(11).fill({ field: 'status', op: 'is', value: 'x' }) } })).status).toBe(400);
    expect((await w.call('GET', '/v1/views?object=cases', A('finance'))).status).toBe((await w.call('GET', '/v1/me', A('finance'))).body.permissions.case?.includes('read') ? 200 : 403);
  });

  it('lets the same name be used again after a view is removed, and needs a signed in user', async () => {
    expect((await w.call('DELETE', `/v1/views/${mine}`, A())).status).toBe(204);
    expect((await mk({ object: 'accounts', name: 'Customers I own' })).status).toBe(201);
    expect((await w.call('GET', '/v1/views?object=accounts', {})).status).toBe(401);
  });
});

describe('bulk import of deals and cases', () => {
  const imp = (path: string, body: unknown, who = A()) => w.call('POST', `/v1/${path}/import`, who, body);
  let acct = '', stage = '', lost = '', queue = '';
  beforeAll(async () => {
    acct = (await w.call('POST', '/v1/accounts', A(), { name: 'Deal Import Co' })).body.id;
    const stages = (await w.call('GET', '/v1/pipeline-stages', A())).body.data;
    stage = stages.find((s: any) => !s.is_closed).id;
    lost = stages.find((s: any) => s.is_closed && !s.is_won).id;
    queue = (await w.call('GET', '/v1/queues', A())).body.data[0].id;
  });

  it('imports deals, filling in the owner and the stage probability', async () => {
    const r = await imp('opportunities', { rows: [
      { name: 'Imp Deal 1', account_id: acct, stage_id: stage, close_date: '2026-12-01', amount: 1000 },
      { name: 'Imp Deal 2', account_id: acct, stage_id: stage, close_date: '2026-12-02', custom: {} }] });
    expect(r.status).toBe(201);
    expect(r.body.created).toBe(2);
    const d = (await w.call('GET', '/v1/opportunities', A())).body.data.filter((x: any) => x.name.startsWith('Imp Deal'));
    expect(d).toHaveLength(2);
    expect(d.every((x: any) => x.owner_user_id === w.tenants.a.users.admin && x.probability >= 0)).toBe(true);
  });

  it('is all or nothing for deals, and names the problem on each row', async () => {
    const r = await imp('opportunities', { rows: [
      { name: 'Should Not Exist 1', account_id: acct, stage_id: stage, close_date: '2026-12-01' },
      { name: 'No Account', stage_id: stage, close_date: '2026-12-01' },
      { name: 'Lost With No Reason', account_id: acct, stage_id: lost, close_date: '2026-12-01' },
      { name: 'Bad Date', account_id: acct, stage_id: stage, close_date: 'soon' }] });
    expect(r.status).toBe(422);
    expect(r.body.error.details.errors.map((e: any) => e.row)).toEqual([2, 3, 4]);
    expect((await w.call('GET', '/v1/opportunities', A())).body.data.map((x: any) => x.name)).not.toContain('Should Not Exist 1');
  });

  it('accepts a lost deal when a reason is given, and will not use another company\'s account', async () => {
    expect((await imp('opportunities', { rows: [{ name: 'Imp Lost', account_id: acct, stage_id: lost, close_date: '2026-01-01', loss_reason: 'price' }] })).body.created).toBe(1);
    const other = (await w.call('POST', '/v1/accounts', B(), { name: 'Not Yours' })).body.id;
    const r = await imp('opportunities', { rows: [{ name: 'Sneaky', account_id: other, stage_id: stage, close_date: '2026-12-01' }] });
    expect(r.status).toBe(422);
  });

  it('imports cases with numbers and deadlines set by the system', async () => {
    const r = await imp('cases', { rows: [
      { subject: 'Imp Case 1', queue_id: queue, description: 'from the old system', priority: 'high', status: 'open' },
      { subject: 'Imp Case 2', owner_user_id: w.tenants.a.users.agent, account_id: acct, status: 'closed' }] });
    expect(r.status).toBe(201);
    const c = (await w.call('GET', '/v1/cases', A())).body.data.filter((x: any) => x.subject.startsWith('Imp Case')).sort((a: any, b: any) => a.case_number - b.case_number);
    expect(c).toHaveLength(2);
    expect(c[1].case_number).toBe(c[0].case_number + 1);
    expect(c[0].resolution_due_at).toBeTruthy();
    expect(c[1].owner_user_id).toBe(w.tenants.a.users.agent);
  });

  it('refuses case rows with no assignee, a bad status, or system fields', async () => {
    const r = await imp('cases', { rows: [
      { subject: 'Nobody' }, { subject: 'Bad', queue_id: queue, status: 'working' }, { subject: 'Number', queue_id: queue, case_number: 5 }, { subject: 'Both', queue_id: queue, owner_user_id: w.tenants.a.users.agent }] });
    expect(r.status).toBe(422);
    expect(r.body.error.details.errors.map((e: any) => e.row)).toEqual([1, 2, 3, 4]);
  });

  it('needs permission, and respects the other company', async () => {
    const me = (await w.call('GET', '/v1/me', A('finance'))).body.permissions;
    expect((await imp('opportunities', { rows: [{ name: 'x' }] }, A('finance'))).status).toBe(me.opportunity?.includes('create') ? 422 : 403);
    expect((await imp('cases', { rows: [{ subject: 'x', queue_id: queue }] }, B())).status).toBe(422);
    expect((await w.call('POST', '/v1/opportunities/import', {}, { rows: [] })).status).toBe(401);
  });
});

describe('backup download', () => {
  it('gives an admin one file with every table, including deleted records and only their own company', async () => {
    const acc = (await w.call('POST', '/v1/accounts', A(), { name: 'Backup Gone Co' })).body;
    await w.call('DELETE', `/v1/accounts/${acc.id}`, A());
    const r = await w.call('GET', '/v1/settings/backup', A());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ format: 'tally-backup', version: 1 });
    expect(Object.keys(r.body.tables)).toEqual(expect.arrayContaining(['account', 'contact', 'opportunity', 'support_case', 'activity', 'app_user', 'custom_field', 'saved_view']));
    const mine = r.body.tables.account;
    expect(mine.find((x: any) => x.id === acc.id)?.deleted_at).toBeTruthy();
    expect(mine.every((x: any) => x.tenant_id === w.tenants.a.id)).toBe(true);
    expect(r.body.counts.account).toBe(mine.length);
    expect(JSON.stringify(r.body.tables.account)).not.toContain('Northstar Secret Co');
  });

  it('is for admins only and needs a signed in user', async () => {
    for (const who of ['sales', 'agent', 'finance']) expect((await w.call('GET', '/v1/settings/backup', A(who))).status).toBe(403);
    expect((await w.call('GET', '/v1/settings/backup', {})).status).toBe(401);
  });
});
