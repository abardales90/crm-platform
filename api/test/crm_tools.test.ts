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
