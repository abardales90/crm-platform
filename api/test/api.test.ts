import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { setup, SECRET, LOGIN_KEY, type World } from './harness.js';

let w: World;
beforeAll(async () => { w = await setup(); }, 60_000);
afterAll(async () => { await w?.teardown(); });

const A = (u = 'admin') => w.as('a', u);
const B = (u = 'admin') => w.as('b', u);

describe('authentication', () => {
  it('rejects a missing token', async () => expect((await w.call('GET', '/v1/accounts', {})).status).toBe(401));
  it('rejects a token signed with the wrong secret', async () => {
    const bad = jwt.sign({ tid: w.tenants.a.id, uid: w.tenants.a.users.admin }, 'x'.repeat(40));
    expect((await w.call('GET', '/v1/accounts', { authorization: `Bearer ${bad}` })).status).toBe(401);
  });
  it('rejects an expired token', async () => {
    const old = jwt.sign({ tid: w.tenants.a.id, uid: w.tenants.a.users.admin, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
    expect((await w.call('GET', '/v1/accounts', { authorization: `Bearer ${old}` })).status).toBe(401);
  });
  it('rejects a user id that belongs to another tenant', async () => {
    const t = jwt.sign({ tid: w.tenants.a.id, uid: w.tenants.b.users.admin }, SECRET);
    expect((await w.call('GET', '/v1/accounts', { authorization: `Bearer ${t}` })).status).toBe(401);
  });
  it('reports who I am and what I can do', async () => {
    const r = await w.call('GET', '/v1/me', A('sales'));
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('sales@tenant-a.test');
    expect(r.body.permissions.account).toEqual(['read', 'create', 'edit']);
    expect(r.body.permissions.case).toEqual(['read']);
  });
  it('also reports who can manage people and roles, so the Settings screen can show the right controls', async () => {
    const admin = await w.call('GET', '/v1/me', A());
    expect(admin.body.permissions.app_user).toEqual(['read', 'create', 'edit', 'delete']);
    expect(admin.body.permissions.role).toEqual(['read', 'create', 'edit', 'delete']);
    const sales = await w.call('GET', '/v1/me', A('sales'));
    expect(sales.body.permissions.app_user).toEqual([]);
  });
});

describe('sandbox login', () => {
  const login = (email: string, key: string) => w.call('POST', '/v1/login', {}, { email, key });
  it('gives a working token for the right email and key', async () => {
    const r = await login('Sales@tenant-a.test', LOGIN_KEY);
    expect(r.status).toBe(200);
    const me = await w.call('GET', '/v1/me', { authorization: `Bearer ${r.body.token}` });
    expect(me.body.user.email).toBe('sales@tenant-a.test');
  });
  it('refuses a wrong key, an unknown email, and an email from the other tenant', async () => {
    expect((await login('sales@tenant-a.test', 'wrong')).status).toBe(401);
    expect((await login('nobody@tenant-a.test', LOGIN_KEY)).status).toBe(401);
    expect((await login('admin@tenant-b.test', LOGIN_KEY)).status).toBe(401);
    expect((await login('', LOGIN_KEY)).status).toBe(401);
  });
  it('locks out an address after 10 failures', async () => {
    for (let i = 0; i < 10; i++) await login('sales@tenant-a.test', 'wrong' + i);
    expect((await login('sales@tenant-a.test', LOGIN_KEY)).status).toBe(429);
  });
});

describe('users list', () => {
  it('shows only my tenant, to any signed in user', async () => {
    const a = await w.call('GET', '/v1/users', A('finance'));
    expect(a.status).toBe(200);
    expect(a.body.data.map((u: any) => u.email).sort()).toEqual(
      ['admin@tenant-a.test', 'agent@tenant-a.test', 'finance@tenant-a.test', 'sales@tenant-a.test']);
    const b = await w.call('GET', '/v1/users', B());
    expect(b.body.data.every((u: any) => u.email.endsWith('tenant-b.test'))).toBe(true);
    expect((await w.call('GET', '/v1/users', {})).status).toBe(401);
  });
});

describe('tenant isolation through the API', () => {
  let aAcct: string, bAcct: string;
  it('creates same-domain accounts in both tenants', async () => {
    const a = await w.call('POST', '/v1/accounts', A(), { name: 'Acme A', domain: 'acme.com' });
    const b = await w.call('POST', '/v1/accounts', B(), { name: 'Acme B', domain: 'acme.com' });
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    aAcct = a.body.id; bAcct = b.body.id;
    expect(a.body.owner_user_id).toBe(w.tenants.a.users.admin);
    expect(a.body.tenant_id).toBeUndefined();
  });
  it('lists only my tenant', async () => {
    const a = await w.call('GET', '/v1/accounts', A());
    const b = await w.call('GET', '/v1/accounts', B());
    expect(a.body.data.map((x: any) => x.name)).toEqual(['Acme A']);
    expect(b.body.data.map((x: any) => x.name)).toEqual(['Acme B']);
  });
  it('cannot read another tenant by id', async () => expect((await w.call('GET', `/v1/accounts/${bAcct}`, A())).status).toBe(404));
  it('cannot edit another tenant by id', async () => {
    const r = await w.call('PATCH', `/v1/accounts/${bAcct}`, A(), { version: 1, name: 'Hacked' });
    expect(r.status).toBe(404);
    expect((await w.call('GET', `/v1/accounts/${bAcct}`, B())).body.name).toBe('Acme B');
  });
  it('cannot delete another tenant by id', async () => {
    expect((await w.call('DELETE', `/v1/accounts/${bAcct}`, A())).status).toBe(404);
    expect((await w.call('GET', `/v1/accounts/${bAcct}`, B())).status).toBe(200);
  });
  it('cannot link my record to another tenant record', async () => {
    const r = await w.call('POST', '/v1/contacts', A(), { last_name: 'Smith', account_id: bAcct });
    expect(r.status).toBe(422);
  });
  it('cannot smuggle a tenant_id in the body', async () => {
    const r = await w.call('POST', '/v1/accounts', A(), { name: 'X', tenant_id: w.tenants.b.id });
    expect(r.status).toBe(400);
  });
  it('filters never reach across tenants', async () => {
    const r = await w.call('GET', '/v1/accounts?domain=acme.com', A());
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0].id).toBe(aAcct);
  });
  it('queue and stage lists are per tenant', async () => {
    const a = await w.call('GET', '/v1/pipeline-stages', A());
    const b = await w.call('GET', '/v1/pipeline-stages', B());
    expect(a.body.data).toHaveLength(6);
    const ids = new Set(a.body.data.map((x: any) => x.id));
    expect(b.body.data.every((x: any) => !ids.has(x.id))).toBe(true);
  });
  it('concurrent requests from two tenants never mix', async () => {
    const calls = Array.from({ length: 40 }, (_, i) => (i % 2 ? w.call('GET', '/v1/accounts', B()) : w.call('GET', '/v1/accounts', A())));
    const res = await Promise.all(calls);
    res.forEach((r, i) => expect(r.body.data.map((x: any) => x.name)).toEqual([i % 2 ? 'Acme B' : 'Acme A']));
  });
});

describe('permissions', () => {
  it('sales can create accounts but cannot delete them', async () => {
    const c = await w.call('POST', '/v1/accounts', A('sales'), { name: 'Sales made' });
    expect(c.status).toBe(201);
    expect((await w.call('DELETE', `/v1/accounts/${c.body.id}`, A('sales'))).status).toBe(403);
  });
  it('sales can read cases but not create them', async () => {
    expect((await w.call('GET', '/v1/cases', A('sales'))).status).toBe(200);
    expect((await w.call('POST', '/v1/cases', A('sales'), { subject: 'x', queue_id: null })).status).toBe(403);
  });
  it('finance viewer is read only and cannot see contacts', async () => {
    expect((await w.call('GET', '/v1/accounts', A('finance'))).status).toBe(200);
    expect((await w.call('POST', '/v1/accounts', A('finance'), { name: 'No' })).status).toBe(403);
    expect((await w.call('GET', '/v1/contacts', A('finance'))).status).toBe(403);
  });
  it('a hidden field is stripped from reads and blocked on edits and filters', async () => {
    const made = await w.call('POST', '/v1/accounts', A(), { name: 'Rich Co', annual_revenue: 5000000 });
    expect(made.body.annual_revenue).toBe('5000000.00');
    const agent = await w.call('GET', `/v1/accounts/${made.body.id}`, A('agent'));
    expect(agent.status).toBe(200);
    expect('annual_revenue' in agent.body).toBe(false);
    expect(agent.body.name).toBe('Rich Co');
    expect((await w.call('GET', '/v1/accounts?annual_revenue=5000000.00', A('agent'))).status).toBe(403);
    // agent can read accounts but not edit them at all
    expect((await w.call('PATCH', `/v1/accounts/${made.body.id}`, A('agent'), { version: 1, name: 'x' })).status).toBe(403);
  });
  it('the same field is visible in tenant B, where no rule hides it', async () => {
    const made = await w.call('POST', '/v1/accounts', B(), { name: 'Rich B', annual_revenue: 10 });
    const r = await w.call('GET', `/v1/accounts/${made.body.id}`, B('agent'));
    expect(r.body.annual_revenue).toBe('10.00');
  });
});

describe('editing rules', () => {
  it('updates with the right version and bumps it', async () => {
    const a = await w.call('POST', '/v1/accounts', A(), { name: 'V1' });
    const u = await w.call('PATCH', `/v1/accounts/${a.body.id}`, A(), { version: a.body.version, name: 'V2' });
    expect(u.status).toBe(200);
    expect(u.body.name).toBe('V2');
    expect(u.body.version).toBe(a.body.version + 1);
  });
  it('rejects a stale version with 409', async () => {
    const a = await w.call('POST', '/v1/accounts', A(), { name: 'Race' });
    await w.call('PATCH', `/v1/accounts/${a.body.id}`, A(), { version: a.body.version, name: 'First' });
    const second = await w.call('PATCH', `/v1/accounts/${a.body.id}`, A('sales'), { version: a.body.version, name: 'Second' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('version_conflict');
    expect((await w.call('GET', `/v1/accounts/${a.body.id}`, A())).body.name).toBe('First');
  });
  it('requires a version on every update', async () => {
    const a = await w.call('POST', '/v1/accounts', A(), { name: 'NoVer' });
    expect((await w.call('PATCH', `/v1/accounts/${a.body.id}`, A(), { name: 'y' })).status).toBe(400);
  });
  it('refuses system and unknown fields', async () => {
    expect((await w.call('POST', '/v1/accounts', A(), { name: 'x', version: 9 })).status).toBe(400);
    expect((await w.call('POST', '/v1/accounts', A(), { name: 'x', nonsense: 1 })).status).toBe(400);
    expect((await w.call('POST', '/v1/accounts', A(), { name: 'x', deleted_at: '2020-01-01' })).status).toBe(400);
  });
  it('turns database rules into clear errors', async () => {
    expect((await w.call('POST', '/v1/accounts', A(), { name: 'Dup', domain: 'acme.com' })).body.error.code).toBe('duplicate');
    expect((await w.call('POST', '/v1/accounts', A(), { name: 'Up', domain: 'UPPER.com' })).status).toBe(422);
    expect((await w.call('POST', '/v1/accounts', A(), {})).body.error.code).toBe('missing_field');
    expect((await w.call('GET', '/v1/accounts/not-a-uuid', A())).status).toBe(404);
  });
  it('soft deletes hide a record and free its unique domain', async () => {
    const a = await w.call('POST', '/v1/accounts', A(), { name: 'Gone', domain: 'gone.com' });
    expect((await w.call('DELETE', `/v1/accounts/${a.body.id}`, A())).status).toBe(204);
    expect((await w.call('GET', `/v1/accounts/${a.body.id}`, A())).status).toBe(404);
    expect((await w.call('GET', '/v1/accounts?domain=gone.com', A())).body.data).toHaveLength(0);
    expect((await w.call('GET', '/v1/accounts?domain=gone.com&include_deleted=true', A())).body.data).toHaveLength(1);
    expect((await w.call('POST', '/v1/accounts', A(), { name: 'Back', domain: 'gone.com' })).status).toBe(201);
  });
  it('returns calendar dates exactly as stored', async () => {
    const a = await w.call('POST', '/v1/accounts', A(), { name: 'Dated', renewal_date: '2027-03-01' });
    expect(a.body.renewal_date).toBe('2027-03-01');
  });
  it('paginates', async () => {
    const first = await w.call('GET', '/v1/accounts?limit=2', A());
    expect(first.body.data).toHaveLength(2);
    expect(first.body.next).toBe(first.body.data[1].id);
    const second = await w.call('GET', `/v1/accounts?limit=2&after=${first.body.next}`, A());
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
  });
});

describe('support cases through the API', () => {
  it('numbers cases per tenant, sets SLA dates, and keeps system fields read only', async () => {
    const qa = (await w.call('GET', '/v1/queues', A())).body.data[0].id;
    const qb = (await w.call('GET', '/v1/queues', B())).body.data[0].id;
    const c1 = await w.call('POST', '/v1/cases', A('agent'), { subject: 'First', queue_id: qa, priority: 'urgent' });
    const c2 = await w.call('POST', '/v1/cases', A('agent'), { subject: 'Second', queue_id: qa });
    const b1 = await w.call('POST', '/v1/cases', B('agent'), { subject: 'B first', queue_id: qb });
    expect([c1.body.case_number, c2.body.case_number, b1.body.case_number]).toEqual([1, 2, 1]);
    expect(new Date(c1.body.first_response_due_at).getTime() - new Date(c1.body.opened_at).getTime()).toBe(60 * 60_000);
    expect((await w.call('POST', '/v1/cases', A('agent'), { subject: 'x', queue_id: qa, case_number: 50 })).status).toBe(400);
    expect((await w.call('POST', '/v1/cases', A('agent'), { subject: 'no owner or queue' })).status).toBe(422);
  });
  it('a public reply from an agent stamps first response', async () => {
    const qa = (await w.call('GET', '/v1/queues', A())).body.data[0].id;
    const c = await w.call('POST', '/v1/cases', A('agent'), { subject: 'Reply me', queue_id: qa });
    expect(c.body.first_response_at).toBeNull();
    const cm = await w.call('POST', '/v1/case-comments', A('agent'), { case_id: c.body.id, body: 'On it', is_public: true, author_user_id: w.tenants.a.users.agent });
    expect(cm.status).toBe(201);
    expect((await w.call('GET', `/v1/cases/${c.body.id}`, A())).body.first_response_at).not.toBeNull();
  });
});

describe('opportunities through the API', () => {
  it('moving to Closed Lost needs a reason, then derives the flags', async () => {
    const stages = (await w.call('GET', '/v1/pipeline-stages', A())).body.data;
    const id = (n: string) => stages.find((s: any) => s.name === n).id;
    const acct = (await w.call('POST', '/v1/accounts', A(), { name: 'Deal Co' })).body.id;
    const o = await w.call('POST', '/v1/opportunities', A('sales'), { account_id: acct, name: 'Big', stage_id: id('Prospecting'), close_date: '2026-12-31' });
    expect(o.status).toBe(201);
    expect(o.body.probability).toBe(10);
    expect((await w.call('PATCH', `/v1/opportunities/${o.body.id}`, A('sales'), { version: 1, stage_id: id('Closed Lost') })).status).toBe(422);
    const lost = await w.call('PATCH', `/v1/opportunities/${o.body.id}`, A('sales'), { version: 1, stage_id: id('Closed Lost'), loss_reason: 'Price' });
    expect(lost.status).toBe(200);
    expect(lost.body.is_closed).toBe(true);
    expect((await w.call('PATCH', `/v1/opportunities/${o.body.id}`, A('sales'), { version: lost.body.version, is_won: true })).status).toBe(400);
  });
  it('a stage from another tenant is refused', async () => {
    const bStage = (await w.call('GET', '/v1/pipeline-stages', B())).body.data[0].id;
    const acct = (await w.call('POST', '/v1/accounts', A(), { name: 'Cross' })).body.id;
    const r = await w.call('POST', '/v1/opportunities', A('sales'), { account_id: acct, name: 'X', stage_id: bStage, close_date: '2026-12-31' });
    expect(r.status).toBe(422);
  });
});

describe('audit trail', () => {
  it('records who changed what, under the request id', async () => {
    const a = await w.call('POST', '/v1/accounts', A('sales'), { name: 'Audited' });
    await w.call('PATCH', `/v1/accounts/${a.body.id}`, A('sales'), { version: 1, name: 'Audited 2' });
    const { default: pg } = await import('pg');
    const root = new pg.Client({ connectionString: (process.env.TEST_ADMIN_URL ?? 'postgresql://postgres@/postgres?host=/var/lib/postgresql/crm_test/sock&port=54329').replace('/postgres?', `/crm_api_test_${process.pid}?`) });
    await root.connect();
    const r = await root.query(`SELECT action, actor_user_id, actor_type, request_id, changes FROM audit_log WHERE record_id = $1 ORDER BY id`, [a.body.id]);
    await root.end();
    expect(r.rows.map((x) => x.action)).toEqual(['insert', 'update']);
    expect(r.rows[1].actor_user_id).toBe(w.tenants.a.users.sales);
    expect(r.rows[1].actor_type).toBe('user');
    expect(r.rows[1].request_id).toBeTruthy();
    expect(r.rows[1].changes.name).toEqual(['Audited', 'Audited 2']);
  });
});
