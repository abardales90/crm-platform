import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, SECRET, type World } from './harness.js';
import { buildApp } from '../src/app.js';

let w: World;
beforeAll(async () => { w = await setup(); }, 60_000);
afterAll(async () => { await w?.teardown(); });

const A = (u = 'admin') => w.as('a', u);
const B = (u = 'admin') => w.as('b', u);
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// ---------------------------------------------------------------- settings

describe('settings: users and roles', () => {
  it('a tenant admin sees every person with their role', async () => {
    const r = await w.call('GET', '/v1/settings/users', A());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(4);
    const admin = r.body.data.find((u: any) => u.email === 'admin@tenant-a.test');
    expect(admin.role_name).toBe('Tenant Admin');
    expect(r.body.data.find((u: any) => u.email === 'sales@tenant-a.test').role_name).toBe('Sales');
  });
  it('people without the user permission cannot see the list or the roles', async () => {
    expect((await w.call('GET', '/v1/settings/users', A('sales'))).status).toBe(403);
    expect((await w.call('GET', '/v1/settings/users', A('agent'))).status).toBe(403);
    expect((await w.call('GET', '/v1/settings/roles', A('sales'))).status).toBe(403);
    expect((await w.call('GET', '/v1/settings/roles', A())).body.data).toHaveLength(8);
  });
  it('invites a person with a role, lowercases the email, and refuses duplicates and bad input', async () => {
    const role = w.tenants.a.roles['Read Only'];
    const r = await w.call('POST', '/v1/settings/users', A(), { email: ' New.Person@Example.com ', display_name: 'New Person', role_id: role });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email: 'new.person@example.com', status: 'invited', role_name: 'Read Only' });
    expect((await w.call('POST', '/v1/settings/users', A(), { email: 'new.person@example.com', display_name: 'Again', role_id: role })).status).toBe(409);
    expect((await w.call('POST', '/v1/settings/users', A(), { email: 'nope', display_name: 'X', role_id: role })).status).toBe(400);
    expect((await w.call('POST', '/v1/settings/users', A(), { email: 'x@example.com', display_name: '', role_id: role })).status).toBe(400);
    expect((await w.call('POST', '/v1/settings/users', A(), { email: 'x@example.com', display_name: 'X' })).status).toBe(400);
    expect((await w.call('POST', '/v1/settings/users', A('sales'), { email: 'y@example.com', display_name: 'Y', role_id: role })).status).toBe(403);
  });
  it('refuses a role from another tenant', async () => {
    const r = await w.call('POST', '/v1/settings/users', A(), { email: 'cross@example.com', display_name: 'Cross', role_id: w.tenants.b.roles['Sales'] });
    expect(r.status).toBe(422);
  });
  it('changes a role and a name, and refuses a stale version', async () => {
    const list = (await w.call('GET', '/v1/settings/users', A())).body.data;
    const finance = list.find((u: any) => u.email === 'finance@tenant-a.test');
    const r = await w.call('PATCH', `/v1/settings/users/${finance.id}`, A(), { version: finance.version, role_id: w.tenants.a.roles['CSM'], display_name: 'Finance Person' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role_name: 'CSM', display_name: 'Finance Person' });
    expect(r.body.version).toBeGreaterThan(finance.version);
    expect((await w.call('PATCH', `/v1/settings/users/${finance.id}`, A(), { version: finance.version, display_name: 'Stale' })).status).toBe(409);
    // put it back for the other tests
    await w.call('PATCH', `/v1/settings/users/${finance.id}`, A(), { version: r.body.version, role_id: w.tenants.a.roles['Finance Viewer'] });
  });
  it('turning someone off locks them out, turning them on restores access', async () => {
    const list = (await w.call('GET', '/v1/settings/users', A())).body.data;
    const sales = list.find((u: any) => u.email === 'sales@tenant-a.test');
    const off = await w.call('PATCH', `/v1/settings/users/${sales.id}`, A(), { version: sales.version, status: 'disabled' });
    expect(off.status).toBe(200);
    expect((await w.call('GET', '/v1/me', A('sales'))).status).toBe(401);
    const on = await w.call('PATCH', `/v1/settings/users/${sales.id}`, A(), { version: off.body.version, status: 'active' });
    expect(on.status).toBe(200);
    expect((await w.call('GET', '/v1/me', A('sales'))).status).toBe(200);
  });
  it('nobody can turn off or demote their own account', async () => {
    const me = (await w.call('GET', '/v1/settings/users', A())).body.data.find((u: any) => u.email === 'admin@tenant-a.test');
    const off = await w.call('PATCH', `/v1/settings/users/${me.id}`, A(), { version: me.version, status: 'disabled' });
    expect(off.status).toBe(400);
    expect(off.body.error.code).toBe('cannot_lock_yourself_out');
    expect((await w.call('PATCH', `/v1/settings/users/${me.id}`, A(), { version: me.version, role_id: w.tenants.a.roles['Read Only'] })).status).toBe(400);
  });
  it('the last Tenant Admin cannot be removed by someone else', async () => {
    // Give the Sales role permission to edit users, so a non admin can try.
    await w.sql(`INSERT INTO role_permission (tenant_id, role_id, object, can_read, can_edit) VALUES ($1, $2, 'app_user', true, true)`,
      [w.tenants.a.id, w.tenants.a.roles['Sales']]);
    const admin = (await w.call('GET', '/v1/settings/users', A('sales'))).body.data.find((u: any) => u.email === 'admin@tenant-a.test');
    const off = await w.call('PATCH', `/v1/settings/users/${admin.id}`, A('sales'), { version: admin.version, status: 'disabled' });
    expect(off.status).toBe(400);
    expect(off.body.error.code).toBe('last_admin');
    const demote = await w.call('PATCH', `/v1/settings/users/${admin.id}`, A('sales'), { version: admin.version, role_id: w.tenants.a.roles['Read Only'] });
    expect(demote.body.error.code).toBe('last_admin');
    await w.sql(`DELETE FROM role_permission WHERE tenant_id = $1 AND role_id = $2 AND object = 'app_user'`, [w.tenants.a.id, w.tenants.a.roles['Sales']]);
  });
  it('cannot reach a user in another tenant', async () => {
    const bUser = (await w.call('GET', '/v1/settings/users', B())).body.data[0];
    expect((await w.call('PATCH', `/v1/settings/users/${bUser.id}`, A(), { version: bUser.version, status: 'disabled' })).status).toBe(404);
  });
});

describe('settings: workspace and email', () => {
  it('shows the workspace name and whether email is set up', async () => {
    const r = await w.call('GET', '/v1/settings/workspace', A('sales'));
    expect(r.body).toMatchObject({ name: 'Tenant a', email: { configured: true, from: 'Support <support@example.test>' } });
  });
  it('an admin can rename the workspace and others cannot', async () => {
    expect((await w.call('PATCH', '/v1/settings/workspace', A(), { name: '  Acme Support  ' })).body.name).toBe('Acme Support');
    expect((await w.call('GET', '/v1/settings/workspace', A())).body.name).toBe('Acme Support');
    expect((await w.call('GET', '/v1/settings/workspace', B())).body.name).toBe('Tenant b');
    expect((await w.call('PATCH', '/v1/settings/workspace', A('sales'), { name: 'Nope' })).status).toBe(403);
    expect((await w.call('PATCH', '/v1/settings/workspace', A(), { name: '   ' })).status).toBe(400);
  });
  it('sends a test email to the signed in admin, and says plainly when the provider refuses', async () => {
    w.mail.sent.length = 0;
    const ok = await w.call('POST', '/v1/settings/email-test', A(), {});
    expect(ok.status).toBe(200);
    expect(w.mail.sent[0]).toMatchObject({ to: 'admin@tenant-a.test', from: 'Support <support@example.test>' });
    w.mail.failWith = 'The domain is not verified';
    const bad = await w.call('POST', '/v1/settings/email-test', A(), {});
    w.mail.failWith = undefined;
    expect(bad.status).toBe(502);
    expect(bad.body.error.message).toContain('not verified');
    expect((await w.call('POST', '/v1/settings/email-test', A('sales'), {})).status).toBe(403);
  });
  it('says email is not set up when there is no provider', async () => {
    const bare = buildApp({ jwtSecret: SECRET });
    await bare.ready();
    const r = await bare.inject({ method: 'POST', url: '/v1/settings/email-test', headers: A() });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body).error.code).toBe('email_not_configured');
    const s = await bare.inject({ method: 'GET', url: '/v1/settings/workspace', headers: A() });
    expect(JSON.parse(s.body).email).toEqual({ configured: false, from: null });
    await bare.close();
  });
});

// ---------------------------------------------------------------- email replies on cases

describe('email replies on cases', () => {
  let queue: string; let acct: string; let contact: string; let noEmail: string; let dnc: string;
  beforeAll(async () => {
    queue = (await w.call('GET', '/v1/queues', A())).body.data[0].id;
    acct = (await w.call('POST', '/v1/accounts', A(), { name: 'Mail Co' })).body.id;
    contact = (await w.call('POST', '/v1/contacts', A(), { last_name: 'Stark', first_name: 'Tony', email: 'tony@mail.test', account_id: acct })).body.id;
    noEmail = (await w.call('POST', '/v1/contacts', A(), { last_name: 'Quiet', account_id: acct })).body.id;
    dnc = (await w.call('POST', '/v1/contacts', A(), { last_name: 'Nope', email: 'nope@mail.test', do_not_contact: true })).body.id;
  });
  const newCase = async (extra: Record<string, unknown> = {}) =>
    (await w.call('POST', '/v1/cases', A('agent'), { subject: 'Printer on fire', queue_id: queue, contact_id: contact, ...extra })).body;

  it('sends the email, records it, posts a public reply, stamps first response and waits on the customer', async () => {
    const c = await newCase();
    w.mail.sent.length = 0;
    const r = await w.call('POST', `/v1/cases/${c.id}/reply`, A('agent'), { body: 'We are looking into it.' });
    expect(r.status).toBe(201);
    expect(w.mail.sent).toHaveLength(1);
    expect(w.mail.sent[0].to).toBe('tony@mail.test');
    expect(w.mail.sent[0].subject).toBe(`Re: [Case #${c.case_number}] Printer on fire`);
    expect(w.mail.sent[0].text).toBe('We are looking into it.\n\nagent');
    const after = (await w.call('GET', `/v1/cases/${c.id}`, A())).body;
    expect(after.first_response_at).not.toBeNull();
    expect(after.status).toBe('pending customer');
    const thread = (await w.call('GET', `/v1/case-comments?case_id=${c.id}`, A())).body.data;
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ body: 'We are looking into it.', is_public: true, author_user_id: w.tenants.a.users.agent });
    const log = (await w.call('GET', `/v1/cases/${c.id}/emails`, A())).body.data;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 'sent', to_email: 'tony@mail.test' });
  });
  it('can set the case status in the same step, and takes a custom subject', async () => {
    const c = await newCase();
    const r = await w.call('POST', `/v1/cases/${c.id}/reply`, A('agent'), { body: 'All fixed.', status: 'solved', subject: 'Your printer' });
    expect(r.status).toBe(201);
    expect(w.mail.sent.at(-1)!.subject).toBe('Your printer');
    expect((await w.call('GET', `/v1/cases/${c.id}`, A())).body.status).toBe('solved');
  });
  it('a failed send says so, keeps a failed record, and leaves no reply or status change behind', async () => {
    const c = await newCase();
    const before = w.mail.sent.length;
    w.mail.failWith = 'The domain is not verified';
    const r = await w.call('POST', `/v1/cases/${c.id}/reply`, A('agent'), { body: 'Hello?' });
    w.mail.failWith = undefined;
    expect(r.status).toBe(502);
    expect(r.body.error.message).toContain('not verified');
    expect(w.mail.sent.length).toBe(before);
    const log = (await w.call('GET', `/v1/cases/${c.id}/emails`, A())).body.data;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 'failed' });
    expect(log[0].error).toContain('not verified');
    expect((await w.call('GET', `/v1/case-comments?case_id=${c.id}`, A())).body.data).toHaveLength(0);
    const after = (await w.call('GET', `/v1/cases/${c.id}`, A())).body;
    expect(after.first_response_at).toBeNull();
    expect(after.status).toBe('new');
  });
  it('explains the problem when there is no contact, no address, or the contact opted out', async () => {
    const none = await newCase({ contact_id: undefined });
    expect((await w.call('POST', `/v1/cases/${none.id}/reply`, A('agent'), { body: 'Hi' })).body.error.code).toBe('no_contact');
    const quiet = await newCase({ contact_id: noEmail });
    expect((await w.call('POST', `/v1/cases/${quiet.id}/reply`, A('agent'), { body: 'Hi' })).body.error.code).toBe('no_email');
    const opted = await newCase({ contact_id: dnc });
    expect((await w.call('POST', `/v1/cases/${opted.id}/reply`, A('agent'), { body: 'Hi' })).body.error.code).toBe('do_not_contact');
  });
  it('checks the input', async () => {
    const c = await newCase();
    expect((await w.call('POST', `/v1/cases/${c.id}/reply`, A('agent'), { body: '   ' })).status).toBe(400);
    expect((await w.call('POST', `/v1/cases/${c.id}/reply`, A('agent'), { body: 'x'.repeat(20_001) })).status).toBe(400);
    expect((await w.call('POST', `/v1/cases/${c.id}/reply`, A('agent'), { body: 'Hi', status: 'bogus' })).status).toBe(400);
    expect((await w.call('POST', `/v1/cases/${c.id}/reply`, A('agent'), { body: 'Hi', subject: 'a\nb'.repeat(100) })).status).toBe(400);
    expect((await w.call('POST', '/v1/cases/not-an-id/reply', A('agent'), { body: 'Hi' })).status).toBe(404);
  });
  it('keeps header characters out of the subject', async () => {
    const c = await newCase({ subject: 'Line one' });
    await w.call('POST', `/v1/cases/${c.id}/reply`, A('agent'), { body: 'Hi', subject: 'Hello\r\nBcc: evil@example.com' });
    expect(w.mail.sent.at(-1)!.subject).toBe('Hello Bcc: evil@example.com');
  });
  it('needs the right permissions', async () => {
    const c = await newCase();
    expect((await w.call('POST', `/v1/cases/${c.id}/reply`, A('sales'), { body: 'Hi' })).status).toBe(403);     // can read cases, cannot write comments
    expect((await w.call('POST', `/v1/cases/${c.id}/reply`, A('finance'), { body: 'Hi' })).status).toBe(403);
    expect((await w.call('GET', `/v1/cases/${c.id}/emails`, A('finance'))).status).toBe(403);
  });
  it('never reaches a case in another tenant', async () => {
    const c = await newCase();
    expect((await w.call('POST', `/v1/cases/${c.id}/reply`, B('agent'), { body: 'Hi' })).status).toBe(404);
    expect((await w.call('GET', `/v1/cases/${c.id}/emails`, B())).body.data).toEqual([]);
  });
  it('says email is not set up when there is no provider', async () => {
    const c = await newCase();
    const bare = buildApp({ jwtSecret: SECRET });
    await bare.ready();
    const r = await bare.inject({ method: 'POST', url: `/v1/cases/${c.id}/reply`, headers: A('agent'), payload: { body: 'Hi' } });
    expect(r.statusCode).toBe(503);
    await bare.close();
    expect((await w.call('GET', `/v1/case-comments?case_id=${c.id}`, A())).body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- reports (all seeded in tenant B)

describe('reports', () => {
  let queue: string;
  const stageId = async (name: string) => (await w.call('GET', '/v1/pipeline-stages', B())).body.data.find((s: any) => s.name === name).id;

  beforeAll(async () => {
    queue = (await w.call('GET', '/v1/queues', B())).body.data[0].id;
    const acct = (await w.call('POST', '/v1/accounts', B(), { name: 'Report Co', type: 'customer', health_score: 80, renewal_date: plusDays(30) })).body.id;
    await w.call('POST', '/v1/accounts', B(), { name: 'Shaky Inc', type: 'customer', health_score: 20, renewal_date: plusDays(200) });
    await w.call('POST', '/v1/accounts', B(), { name: 'Middling LLC', type: 'prospect', health_score: 55 });
    await w.call('POST', '/v1/accounts', B(), { name: 'Late Ltd', type: 'customer', health_score: 70, renewal_date: plusDays(-5) });
    await w.call('POST', '/v1/accounts', B(), { name: 'Unscored Co' });

    // cases: urgent (replied then solved), normal (replied), low (untouched)
    const c1 = (await w.call('POST', '/v1/cases', B('agent'), { subject: 'One', queue_id: queue, priority: 'urgent' })).body;
    const c2 = (await w.call('POST', '/v1/cases', B('agent'), { subject: 'Two', queue_id: queue, priority: 'normal' })).body;
    await w.call('POST', '/v1/cases', B('agent'), { subject: 'Three', queue_id: queue, priority: 'low' });
    for (const c of [c1, c2]) await w.call('POST', '/v1/case-comments', B('agent'), { case_id: c.id, body: 'On it', is_public: true, author_user_id: w.tenants.b.users.agent });
    await w.call('PATCH', `/v1/cases/${c1.id}`, B('agent'), { version: (await w.call('GET', `/v1/cases/${c1.id}`, B())).body.version, status: 'solved' });

    // deals: two open, one won, one lost
    const mk = (name: string, stage: string, amount: number, extra: Record<string, unknown> = {}) =>
      stageId(stage).then((s) => w.call('POST', '/v1/opportunities', B('sales'), { account_id: acct, name, stage_id: s, amount, close_date: plusDays(20), ...extra }));
    expect((await mk('Small', 'Prospecting', 1000)).status).toBe(201);
    expect((await mk('Big', 'Negotiation', 4000)).status).toBe(201);
    expect((await mk('Won deal', 'Closed Won', 2000, { close_date: today() })).status).toBe(201);
    expect((await mk('Lost deal', 'Closed Lost', 500, { close_date: today(), loss_reason: 'Price' })).status).toBe(201);
  }, 60_000);

  it('support: counts, SLA and breakdowns match what was created', async () => {
    const r = await w.call('GET', '/v1/reports/support?days=30', B('sales'));
    expect(r.status).toBe(200);
    expect(r.body.totals).toMatchObject({ opened: 3, solved: 1, open_now: 2, past_sla_now: 0, first_response_met_pct: 100, resolution_met_pct: 100 });
    expect(r.body.totals.avg_first_response_minutes).toBeGreaterThanOrEqual(0);
    expect(r.body.totals.avg_resolution_hours).toBeGreaterThanOrEqual(0);
    expect(r.body.unit).toBe('day');
    expect(r.body.series.reduce((s: number, p: any) => s + p.opened, 0)).toBe(3);
    expect(r.body.series.reduce((s: number, p: any) => s + p.solved, 0)).toBe(1);
    expect(r.body.series.at(-1).bucket).toBe(today());
    expect(r.body.by_priority).toEqual([{ label: 'urgent', n: 1 }, { label: 'normal', n: 1 }, { label: 'low', n: 1 }]);
    expect(r.body.by_status.reduce((s: number, p: any) => s + p.n, 0)).toBe(2);
    expect(r.body.open_by_assignee).toEqual([{ label: 'Queue: General', n: 2 }]);
  });
  it('support: long ranges group by week, and the range is limited', async () => {
    const r = await w.call('GET', '/v1/reports/support?days=90', B());
    expect(r.body.unit).toBe('week');
    expect(r.body.series.length).toBeGreaterThan(10);
    expect((await w.call('GET', '/v1/reports/support?days=100000', B())).body.days).toBe(365);
    expect((await w.call('GET', '/v1/reports/support?days=abc', B())).body.days).toBe(30);
  });
  it('support: an overdue open case shows as past SLA', async () => {
    const c = (await w.call('POST', '/v1/cases', B('agent'), { subject: 'Late', queue_id: queue, priority: 'urgent' })).body;
    await w.sql(`UPDATE support_case SET first_response_due_at = now() - interval '2 hours', resolution_due_at = now() - interval '1 hour' WHERE id = $1`, [c.id]);
    const r = await w.call('GET', '/v1/reports/support', B());
    expect(r.body.totals.past_sla_now).toBe(1);
    expect(r.body.totals.first_response_met_pct).toBeLessThan(100);   // a due time passed with no reply
    await w.sql(`UPDATE support_case SET deleted_at = now() WHERE id = $1`, [c.id]);
  });
  it('support: needs permission to read cases', async () => {
    expect((await w.call('GET', '/v1/reports/support', B('finance'))).status).toBe(403);
    expect((await w.call('GET', '/v1/reports/support', {})).status).toBe(401);
  });

  it('pipeline: totals, stages, win rate and loss reasons match the deals', async () => {
    const r = await w.call('GET', '/v1/reports/pipeline?days=90', B('sales'));
    expect(r.status).toBe(200);
    expect(r.body.open).toEqual({ count: 2, amount: 5000, weighted: 3100 });
    expect(r.body.closed).toEqual({ won_count: 1, won_amount: 2000, lost_count: 1, lost_amount: 500, win_rate_pct: 50, avg_won_size: 2000 });
    const byStage = Object.fromEntries(r.body.open_by_stage.map((s: any) => [s.label, s]));
    expect(byStage.Prospecting).toMatchObject({ n: 1, amount: 1000, weighted: 100 });
    expect(byStage.Negotiation).toMatchObject({ n: 1, amount: 4000, weighted: 3000 });
    expect(r.body.open_by_stage.map((s: any) => s.label)).toEqual(['Prospecting', 'Qualification', 'Proposal', 'Negotiation']);
    expect(r.body.forecast_by_month.reduce((s: number, m: any) => s + m.amount, 0)).toBe(5000);
    expect(r.body.top_open_deals.map((d: any) => d.name)).toEqual(['Big', 'Small']);
    expect(r.body.top_open_deals[0]).toMatchObject({ account: 'Report Co', stage: 'Negotiation', amount: 4000 });
    expect(r.body.loss_reasons).toEqual([{ label: 'Price', n: 1 }]);
    expect(r.body.open_by_owner[0]).toMatchObject({ label: 'sales', n: 2, amount: 5000 });
  });
  it('pipeline: a window with no closed deals has no win rate', async () => {
    await w.sql(`UPDATE opportunity SET close_date = current_date - 60 WHERE tenant_id = $1 AND is_closed`, [w.tenants.b.id]);
    const r = await w.call('GET', '/v1/reports/pipeline?days=7', B());
    expect(r.body.closed).toMatchObject({ won_count: 0, lost_count: 0, win_rate_pct: null, avg_won_size: null });
    await w.sql(`UPDATE opportunity SET close_date = current_date WHERE tenant_id = $1 AND is_closed`, [w.tenants.b.id]);
  });
  it('pipeline: respects object and field permissions', async () => {
    expect((await w.call('GET', '/v1/reports/pipeline', B('agent'))).status).toBe(403);           // cannot read deals
    expect((await w.call('GET', '/v1/reports/pipeline', B('finance'))).status).toBe(200);         // read only is enough
    await w.sql(`INSERT INTO field_permission (tenant_id, role_id, object, field, access) VALUES ($1, $2, 'opportunity', 'amount', 'none')`,
      [w.tenants.b.id, w.tenants.b.roles['Finance Viewer']]);
    const hidden = await w.call('GET', '/v1/reports/pipeline', B('finance'));
    expect(hidden.status).toBe(403);
    expect(hidden.body.error.code).toBe('field_forbidden');
    await w.sql(`DELETE FROM field_permission WHERE tenant_id = $1 AND object = 'opportunity' AND field = 'amount'`, [w.tenants.b.id]);
  });
  it('pipeline: account names are hidden from people who cannot read accounts', async () => {
    await w.sql(`UPDATE role_permission SET can_read = false, can_edit = false, can_create = false, can_delete = false WHERE tenant_id = $1 AND role_id = $2 AND object = 'account'`,
      [w.tenants.b.id, w.tenants.b.roles['Finance Viewer']]);
    const r = await w.call('GET', '/v1/reports/pipeline', B('finance'));
    expect(r.status).toBe(200);
    expect(r.body.top_open_deals.every((d: any) => d.account === null)).toBe(true);
    await w.sql(`UPDATE role_permission SET can_read = true WHERE tenant_id = $1 AND role_id = $2 AND object = 'account'`, [w.tenants.b.id, w.tenants.b.roles['Finance Viewer']]);
  });
  it('pipeline: one tenant never sees the other tenant deals', async () => {
    const r = await w.call('GET', '/v1/reports/pipeline', A());
    expect(r.body.open).toEqual({ count: 0, amount: 0, weighted: 0 });
    expect(r.body.top_open_deals).toEqual([]);
  });

  it('accounts: health bands, renewals and at risk list match the accounts', async () => {
    const r = await w.call('GET', '/v1/reports/accounts', B('sales'));
    expect(r.status).toBe(200);
    expect(r.body.totals).toMatchObject({ total: 5, customers: 3, at_risk: 1, watch: 1, healthy: 2, unscored: 1 });
    expect(r.body.health.map((h: any) => h.n)).toEqual([1, 1, 2, 1]);
    expect(r.body.by_type).toEqual([{ label: 'customer', n: 3 }, { label: 'prospect', n: 1 }, { label: 'unspecified', n: 1 }]);
    expect(r.body.at_risk.map((a: any) => a.name)).toEqual(['Shaky Inc']);
    expect(r.body.renewals_next_90_days.map((a: any) => a.name)).toEqual(['Report Co']);
    expect(r.body.renewals_next_90_days[0].days_left).toBe(30);
    expect(r.body.customer_renewals_past_due).toBe(1);
  });
  it('accounts: needs account access and the health fields', async () => {
    expect((await w.call('GET', '/v1/reports/accounts', B('agent'))).body.totals.total).toBe(5);   // agents read accounts
    await w.sql(`INSERT INTO field_permission (tenant_id, role_id, object, field, access) VALUES ($1, $2, 'account', 'health_score', 'none')`,
      [w.tenants.b.id, w.tenants.b.roles['Support Agent']]);
    expect((await w.call('GET', '/v1/reports/accounts', B('agent'))).status).toBe(403);
    await w.sql(`DELETE FROM field_permission WHERE tenant_id = $1 AND object = 'account' AND field = 'health_score'`, [w.tenants.b.id]);
    expect((await w.call('GET', '/v1/reports/accounts', A())).body.totals.total).not.toBe(5);       // tenant A has its own accounts
  });
});

// ---------------------------------------------------------------- preferences

describe('my preferences', () => {
  it('start empty, then remember a color, the tour and the last update seen', async () => {
    const first = await w.call('GET', '/v1/me/preferences', A('sales'));
    expect(first.body).toEqual({ accent: null, tour_done_at: null, last_seen_release: null });
    expect((await w.call('PUT', '/v1/me/preferences', A('sales'), { accent: 'purple' })).body.accent).toBe('purple');
    const done = await w.call('PUT', '/v1/me/preferences', A('sales'), { tour_done: true, last_seen_release: '0.4' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ accent: 'purple', last_seen_release: '0.4' });
    expect(done.body.tour_done_at).toBeTruthy();
    const stamp = done.body.tour_done_at;
    const again = await w.call('PUT', '/v1/me/preferences', A('sales'), { tour_done: true });
    expect(again.body.tour_done_at).toBe(stamp);         // finishing twice keeps the first time
  });
  it('are private to each person and each workspace', async () => {
    expect((await w.call('GET', '/v1/me/preferences', A('agent'))).body.accent).toBeNull();
    expect((await w.call('GET', '/v1/me/preferences', B('sales'))).body.accent).toBeNull();
  });
  it('a person with the lowest access can still set their own look', async () => {
    expect((await w.call('PUT', '/v1/me/preferences', A('finance'), { accent: 'rose' })).status).toBe(200);
  });
  it('reject unknown colors and empty or odd requests', async () => {
    expect((await w.call('PUT', '/v1/me/preferences', A(), { accent: 'hotpink' })).status).toBe(400);
    expect((await w.call('PUT', '/v1/me/preferences', A(), {})).status).toBe(400);
    expect((await w.call('PUT', '/v1/me/preferences', A(), { tour_done: false })).status).toBe(400);
    expect((await w.call('PUT', '/v1/me/preferences', A(), { last_seen_release: '' })).status).toBe(400);
  });
  it('need a sign in', async () => {
    expect((await w.call('GET', '/v1/me/preferences', undefined as any)).status).toBe(401);
  });
});
