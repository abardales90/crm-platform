import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withTenant, type Db } from './db.js';
import { addressOf } from './email.js';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

export type InboundConfig = {
  secret: string;          // Resend webhook signing secret, looks like whsec_...
  apiKey: string;          // used to read the full message
  tenantId: string;
  fetchEmail?: (id: string) => Promise<ReceivedEmail>;   // replaced in tests
};

export type ReceivedEmail = {
  id: string; from: string; to: string[]; subject: string; text: string | null; html: string | null;
  headers: Record<string, string>; authentication?: { spf?: string; dkim?: string; dmarc?: string } | null;
};

// Svix signing: HMAC SHA256 of "id.timestamp.body" with the secret (after whsec_, base64 decoded). https://docs.svix.com
export function verifySignature(secret: string, id: string, timestamp: string, body: string, header: string, nowMs = Date.now()): boolean {
  const ts = Number(timestamp);
  if (!id || !Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 5 * 60) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const want = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  for (const part of header.split(' ')) {
    const [v, sig] = part.split(',');
    if (v !== 'v1' || !sig) continue;
    const got = Buffer.from(sig, 'base64');
    if (got.length === want.length && timingSafeEqual(got, want)) return true;
  }
  return false;
}

// Keep what the person just wrote and drop the quoted history under it.
export function newPartOf(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex((l, i) =>
    /^On .{5,200} wrote:\s*$/.test(l) || /^-{2,}\s*(Original Message|Forwarded message)/i.test(l) ||
    /^From:\s.+/.test(l) && /^(Sent|Date):/.test(lines[i + 1] ?? '') || (/^On .{5,200}$/.test(l) && /wrote:\s*$/.test(lines[i + 1] ?? '')));
  const kept = (cut >= 0 ? lines.slice(0, cut) : lines).filter((l, i, a) => !(l.startsWith('>') && a.slice(i).every((x) => x.startsWith('>') || !x.trim())));
  const out = kept.join('\n').trim();
  return out || raw.trim();
}

export function textOf(m: ReceivedEmail): string {
  if (m.text && m.text.trim()) return m.text;
  return (m.html ?? '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n');
}

// Automatic replies, bounces and mailing lists never become cases. This stops two robots writing to each other.
export function isAutomatic(m: ReceivedEmail, ownDomain: string): boolean {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.headers ?? {})) h[k.toLowerCase()] = String(v).toLowerCase();
  const auto = h['auto-submitted'];
  if (auto && auto !== 'no') return true;
  if (/bulk|junk|list|auto_reply/.test(h['precedence'] ?? '')) return true;
  if (h['x-autoreply'] || h['x-autorespond'] || h['list-unsubscribe'] || h['x-auto-response-suppress']) return true;
  const from = addressOf(m.from).toLowerCase();
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/.test(from)) return true;
  return !!ownDomain && from.endsWith('@' + ownDomain);
}

const nameParts = (from: string, email: string) => {
  const display = from.includes('<') ? from.slice(0, from.indexOf('<')).replace(/["']/g, '').trim() : '';
  const words = (display || email.split('@')[0].replace(/[._+-]+/g, ' ')).split(/\s+/).filter(Boolean);
  const last = words.length > 1 ? words.slice(1).join(' ') : words[0] || email;
  return { first: words.length > 1 ? words[0] : null, last: last.slice(0, 120) };
};

export async function handleReceived(db: Db, m: ReceivedEmail, ownDomain: string) {
  const sender = addressOf(m.from).toLowerCase();
  if (!sender.includes('@')) return 'ignored' as const;
  const dup = await db.query(`SELECT 1 FROM email_message WHERE direction = 'in' AND provider_message_id = $1`, [m.id]);
  if (dup.rowCount) return 'duplicate' as const;

  const subject = (m.subject || '(no subject)').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || '(no subject)';
  const full = textOf(m).trim().slice(0, 20_000) || '(empty message)';
  const fresh = newPartOf(full).slice(0, 20_000);
  const tenantId = (await db.query(`SELECT current_tenant_id() AS t`)).rows[0].t;
  const toAddr = (m.to?.[0] ? addressOf(m.to[0]) : '') || 'unknown@unknown.invalid';

  // Which case is this about? The case number in the subject, or the number tucked into the address we sent from.
  const num = subject.match(/\[Case #(\d+)\]/i)?.[1] ?? (m.to ?? []).map((t) => addressOf(t).match(/\+c(\d+)@/i)?.[1]).find(Boolean);
  let c = num ? (await db.query(`SELECT id, status, contact_id FROM support_case WHERE case_number = $1 AND deleted_at IS NULL`, [Number(num)])).rows[0] : undefined;

  let contactId: string | null = c?.contact_id ?? null;
  const known = (await db.query(`SELECT id, account_id FROM contact WHERE lower(email) = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [sender])).rows[0];

  if (!c) {
    let accountId: string | null = known?.account_id ?? null;
    contactId = known?.id ?? null;
    if (!contactId) {
      const owner = (await db.query(`SELECT id FROM app_user WHERE deleted_at IS NULL AND status <> 'disabled' ORDER BY created_at LIMIT 1`)).rows[0];
      if (!owner) return 'ignored' as const;
      const n = nameParts(m.from, sender);
      contactId = (await db.query(
        `INSERT INTO contact (tenant_id, first_name, last_name, email, owner_user_id, lead_source) VALUES ($1, $2, $3, $4, $5, 'email') RETURNING id`,
        [tenantId, n.first, n.last, sender, owner.id])).rows[0].id;
    }
    const q = (await db.query(`SELECT id FROM queue WHERE is_active AND deleted_at IS NULL ORDER BY (lower(name) = 'support') DESC, created_at LIMIT 1`)).rows[0];
    c = (await db.query(
      `INSERT INTO support_case (tenant_id, subject, description, origin, contact_id, account_id, queue_id)
       VALUES ($1, $2, $3, 'email', $4, $5, $6) RETURNING id, status, contact_id`,
      [tenantId, subject.replace(/^(re|fw|fwd):\s*/i, '').trim() || subject, fresh, contactId, accountId, q?.id ?? null])).rows[0];
    await db.query(`INSERT INTO case_comment (tenant_id, case_id, author_user_id, body, is_public, via_email) VALUES ($1, $2, NULL, $3, true, true)`, [tenantId, c.id, fresh]);
  } else {
    const who = (await db.query(`SELECT email FROM contact WHERE id = $1`, [contactId])).rows[0]?.email;
    const note = who && who.toLowerCase() !== sender ? `From ${sender}:\n\n` : '';
    await db.query(`INSERT INTO case_comment (tenant_id, case_id, author_user_id, body, is_public, via_email) VALUES ($1, $2, NULL, $3, true, true)`, [tenantId, c.id, note + fresh]);
    if (['solved', 'closed', 'pending customer'].includes(c.status)) await db.query(`UPDATE support_case SET status = 'open' WHERE id = $1`, [c.id]);
  }

  await db.query(
    `INSERT INTO email_message (tenant_id, case_id, contact_id, to_email, from_email, subject, body, status, direction, provider_message_id, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'received', 'in', $8, now())`,
    [tenantId, c.id, contactId, toAddr, sender, subject, full, m.id]);
  return (num && c ? 'attached' : 'new_case') as 'attached' | 'new_case';
}

export async function fetchReceived(apiKey: string, id: string): Promise<ReceivedEmail> {
  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Resend would not give the message (${res.status}). The API key may need Full access.`);
  const j: any = await res.json();
  return { id: String(j.id ?? id), from: String(j.from ?? ''), to: Array.isArray(j.to) ? j.to.map(String) : [], subject: String(j.subject ?? ''),
    text: j.text ?? null, html: j.html ?? null, headers: j.headers ?? {}, authentication: j.authentication ?? null };
}

export function inboundRoutes(app: FastifyInstance, cfg: InboundConfig | undefined, ownDomain: string) {
  if (!cfg) return;
  // Own little scope so this route can read the raw body, which the signature needs.
  app.register(async (s) => {
    s.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    s.post('/v1/webhooks/resend', async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      const hd = req.headers;
      if (!verifySignature(cfg.secret, String(hd['svix-id'] ?? ''), String(hd['svix-timestamp'] ?? ''), raw, String(hd['svix-signature'] ?? ''))) {
        return reply.code(401).send({ error: { code: 'bad_signature', message: 'Signature did not match' } });
      }
      let ev: any;
      try { ev = JSON.parse(raw); } catch { return reply.code(400).send({ error: { code: 'bad_request', message: 'Not JSON' } }); }
      if (ev?.type !== 'email.received' || !ev?.data?.email_id) return { ok: true, ignored: true };

      const msg = await (cfg.fetchEmail ?? ((id) => fetchReceived(cfg.apiKey, id)))(String(ev.data.email_id));
      if (msg.authentication?.dmarc === 'fail') { req.log.warn({ from: msg.from }, 'inbound email failed DMARC and was dropped'); return { ok: true, dropped: 'dmarc' }; }
      if (isAutomatic(msg, ownDomain)) return { ok: true, dropped: 'automatic' };
      const result = await withTenant({ tenantId: cfg.tenantId, userId: SYSTEM_USER, actorType: 'system', requestId: req.id }, (db) => handleReceived(db, msg, ownDomain));
      return { ok: true, result };
    });
  });
}
