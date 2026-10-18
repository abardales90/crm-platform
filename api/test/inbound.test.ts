import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { setup, WEBHOOK_SECRET, type World } from './harness.js';
import { newPartOf, verifySignature } from '../src/inbound.js';

let w: World;
beforeAll(async () => { w = await setup(); }, 60_000);
afterAll(async () => { await w?.teardown(); });
const A = (u = 'admin') => w.as('a', u);

let seq = 0;
// Delivers an email the way Resend does: a signed webhook that names the message, which the app then reads by id.
async function deliver(msg: { from: string; to?: string[]; subject: string; text: string; headers?: Record<string, string>; dmarc?: string }, opts: { sign?: boolean; ts?: number } = {}) {
  const id = `rcv-${++seq}-${Math.random().toString(36).slice(2)}`;
  w.inbox[id] = { id, from: msg.from, to: msg.to ?? ['support@example.test'], subject: msg.subject, text: msg.text, html: null,
    headers: msg.headers ?? {}, authentication: { dmarc: msg.dmarc ?? 'pass' } };
  return { id, ...(await post({ type: 'email.received', data: { email_id: id } }, opts)) };
}
async function post(payload: unknown, opts: { sign?: boolean; ts?: number } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const mid = 'msg_' + Math.random().toString(36).slice(2);
  const key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${mid}.${ts}.${body}`).digest('base64');
  const r = await w.app.inject({ method: 'POST', url: '/v1/webhooks/resend', payload: body,
    headers: { 'content-type': 'application/json', 'svix-id': mid, 'svix-timestamp': ts, 'svix-signature': opts.sign === false ? 'v1,AAAA' : `v1,${sig}` } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}

describe('inbound email', () => {
  let contact: string; let queue: string;
  beforeAll(async () => {
    queue = (await w.call('GET', '/v1/queues', A())).body.data[0].id;
    contact = (await w.call('POST', '/v1/contacts', A(), { last_name: 'Stark', first_name: 'Tony', email: 'tony@mail.test' })).body.id;
  });
  const newCase = async () => (await w.call('POST', '/v1/cases', A('agent'), { subject: 'Printer on fire', queue_id: queue, contact_id: contact })).body;

  it('refuses a webhook with a bad or old signature, and does nothing with it', async () => {
    const before = (await w.sql(`SELECT count(*)::int AS n FROM email_message`)).rows[0].n;
    expect((await post({ type: 'email.received', data: { email_id: 'x' } }, { sign: false })).status).toBe(401);
    expect((await post({ type: 'email.received', data: { email_id: 'x' } }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await w.sql(`SELECT count(*)::int AS n FROM email_message`)).rows[0].n).toBe(before);
    expect(verifySignature(WEBHOOK_SECRET, 'a', String(Math.floor(Date.now() / 1000)), '{}', '')).toBe(false);
  });

  it('puts a reply on its case, shows it in the conversation, and reopens a solved case', async () => {
    const c = await newCase();
    await w.call('PATCH', `/v1/cases/${c.id}`, A(), { version: c.version, status: 'solved' });
    const r = await deliver({ from: 'Tony Stark <Tony@mail.test>', subject: `Re: [Case #${c.case_number}] Printer on fire`,
      text: 'It is still burning.\n\nOn Mon, Oct 12, 2026 at 9:00 AM Support <support@example.test> wrote:\n> We fixed it.\n> Honest.' });
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('attached');
    const thread = (await w.call('GET', `/v1/case-comments?case_id=${c.id}`, A())).body.data;
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ body: 'It is still burning.', is_public: true, author_user_id: null, via_email: true });
    expect((await w.call('GET', `/v1/cases/${c.id}`, A())).body.status).toBe('open');
    const log = (await w.call('GET', `/v1/cases/${c.id}/emails`, A())).body.data;
    expect(log[0]).toMatchObject({ direction: 'in', status: 'received', from_email: 'tony@mail.test' });
  });

  it('finds the case from the address we sent from, even if the subject was changed', async () => {
    const c = await newCase();
    const r = await deliver({ from: 'tony@mail.test', to: [`Support <support+c${c.case_number}@example.test>`], subject: 'something else entirely', text: 'Any news?' });
    expect(r.body.result).toBe('attached');
    expect((await w.call('GET', `/v1/case-comments?case_id=${c.id}`, A())).body.data).toHaveLength(1);
  });

  it('opens a new case for a message that is not a reply, and creates the contact', async () => {
    const r = await deliver({ from: 'Pat Lee <pat@newco.test>', subject: 'Cannot log in', text: 'Help, I cannot log in.' });
    expect(r.body.result).toBe('new_case');
    const row = (await w.sql(`SELECT c.id, c.origin, c.status, c.description, c.queue_id, k.email, k.first_name, k.last_name FROM support_case c JOIN contact k ON k.id = c.contact_id WHERE c.subject = 'Cannot log in' AND c.tenant_id = $1`, [w.tenants.a.id])).rows[0];
    expect(row).toMatchObject({ origin: 'email', status: 'new', description: 'Help, I cannot log in.', email: 'pat@newco.test', first_name: 'Pat', last_name: 'Lee' });
    expect(row.queue_id).toBeTruthy();
    const first = (await w.call('GET', `/v1/case-comments?case_id=${row.id}`, A())).body.data;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ body: 'Help, I cannot log in.', via_email: true });
    // The same person writing again uses the same contact.
    await deliver({ from: 'pat@newco.test', subject: 'Another thing', text: 'Second question' });
    expect((await w.sql(`SELECT count(*)::int AS n FROM contact WHERE email = 'pat@newco.test' AND tenant_id = $1`, [w.tenants.a.id])).rows[0].n).toBe(1);
  });

  it('is safe to deliver twice', async () => {
    const c = await newCase();
    const id = 'dup-1';
    w.inbox[id] = { id, from: 'tony@mail.test', to: ['support@example.test'], subject: `[Case #${c.case_number}] hi`, text: 'once', html: null, headers: {}, authentication: null };
    await post({ type: 'email.received', data: { email_id: id } });
    const again = await post({ type: 'email.received', data: { email_id: id } });
    expect(again.body.result).toBe('duplicate');
    expect((await w.call('GET', `/v1/case-comments?case_id=${c.id}`, A())).body.data).toHaveLength(1);
  });

  it('drops automatic replies, our own mail and messages that fail the sender check', async () => {
    const count = async () => (await w.sql(`SELECT count(*)::int AS n FROM support_case WHERE tenant_id = $1`, [w.tenants.a.id])).rows[0].n;
    const n = await count();
    expect((await deliver({ from: 'ooo@mail.test', subject: 'Out of office', text: 'away', headers: { 'Auto-Submitted': 'auto-replied' } })).body.dropped).toBe('automatic');
    expect((await deliver({ from: 'MAILER-DAEMON@mail.test', subject: 'Undeliverable', text: 'bounce' })).body.dropped).toBe('automatic');
    expect((await deliver({ from: 'Support <support@example.test>', subject: 'loop', text: 'us' })).body.dropped).toBe('automatic');
    expect((await deliver({ from: 'boss@mail.test', subject: 'Wire the money', text: 'now', dmarc: 'fail' })).body.dropped).toBe('dmarc');
    expect(await count()).toBe(n);
  });

  it('ignores other events and keeps tenant B untouched', async () => {
    expect((await post({ type: 'email.delivered', data: { email_id: 'x' } })).body.ignored).toBe(true);
    expect((await w.sql(`SELECT count(*)::int AS n FROM email_message WHERE tenant_id = $1 AND direction = 'in'`, [w.tenants.b.id])).rows[0].n).toBe(0);
  });

  it('marks a note written by a person as not an email, and people cannot fake the mark', async () => {
    const c = await newCase();
    const fake = await w.call('POST', '/v1/case-comments', A('agent'), { case_id: c.id, body: 'Called them', is_public: false, via_email: true });
    expect(fake.status).toBe(400);
    const real = (await w.call('POST', '/v1/case-comments', A('agent'), { case_id: c.id, body: 'Called them', is_public: false })).body;
    expect(real.via_email).toBe(false);
  });

  it('sends each reply with a reply to address that carries the case number', async () => {
    const c = await newCase();
    w.mail.sent.length = 0;
    await w.call('POST', `/v1/cases/${c.id}/reply`, A('agent'), { body: 'On it.' });
    expect((await w.call('GET', `/v1/case-comments?case_id=${c.id}`, A())).body.data[0].via_email).toBe(true);
    expect(w.mail.sent[0].replyTo).toBe(`support+c${c.case_number}@example.test`);
  });

  it('keeps the new part of a message and drops the quoted history', () => {
    expect(newPartOf('Thanks!\n\n-----Original Message-----\nFrom: a\nold')).toBe('Thanks!');
    expect(newPartOf('Yes\n\nOn Tue, Oct 13, 2026 at 3:00 PM Bob\n<bob@x.test> wrote:\n> hi')).toBe('Yes');
    expect(newPartOf('> only quoted')).toBe('> only quoted');
  });
});
