import type { FastifyInstance } from 'fastify';
import { type Kit, UUID } from './kit.js';
import { ApiError } from './errors.js';
import { EmailError, type EmailConfig } from './email.js';

const STATUSES = ['new', 'open', 'pending customer', 'escalated', 'solved', 'closed'];

// Reply to a customer by email from a case.
// 1. check everything and write a "queued" record, 2. send with no database transaction held open,
// 3. record the outcome. A failed send never leaves a public reply behind.
export function caseMailRoutes(app: FastifyInstance, kit: Kit, email: EmailConfig | undefined) {
  const { authed, can } = kit;

  app.get('/v1/cases/:id/emails', async (req) =>
    authed(req, async (db, userId) => {
      const { id } = req.params as { id: string };
      if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Not found');
      await can(db, userId, 'case', 'read');
      const r = await db.query(
        `SELECT id, to_email, from_email, direction, subject, status, error, sent_at, created_at, created_by FROM email_message
          WHERE case_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [id]);
      return { data: r.rows };
    }));

  app.post('/v1/cases/:id/reply', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Not found');
    const b: any = req.body ?? {};
    const text = typeof b.body === 'string' ? b.body.trim() : '';
    if (!text) throw new ApiError(400, 'bad_request', 'Write a message first');
    if (text.length > 20_000) throw new ApiError(400, 'bad_request', 'That message is too long');
    if (b.status !== undefined && !STATUSES.includes(b.status)) throw new ApiError(400, 'bad_request', 'Unknown case status');
    if (b.subject !== undefined && (typeof b.subject !== 'string' || !b.subject.trim() || b.subject.length > 200)) throw new ApiError(400, 'bad_request', 'The subject must be 1 to 200 characters');

    const prep = await authed(req, async (db, userId) => {
      await can(db, userId, 'case', 'read');
      await can(db, userId, 'case_comment', 'create');
      await can(db, userId, 'contact', 'read');
      if (b.status !== undefined) await can(db, userId, 'case', 'edit');
      if (!email) throw new ApiError(503, 'email_not_configured', 'Email is not set up yet. Add RESEND_API_KEY and EMAIL_FROM in Render, then try again.');
      const c = (await db.query(`SELECT id, case_number, subject, contact_id, status FROM support_case WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0];
      if (!c) throw new ApiError(404, 'not_found', 'Not found');
      if (!c.contact_id) throw new ApiError(422, 'no_contact', 'This case has no contact. Add one before you email.');
      const ct = (await db.query(`SELECT email, do_not_contact FROM contact WHERE id = $1 AND deleted_at IS NULL`, [c.contact_id])).rows[0];
      if (!ct?.email) throw new ApiError(422, 'no_email', 'The contact on this case has no email address.');
      if (ct.do_not_contact) throw new ApiError(422, 'do_not_contact', 'This contact is marked Do Not Contact.');
      const me = (await db.query(`SELECT display_name FROM app_user WHERE id = $1`, [userId])).rows[0];
      const subject = (b.subject ? String(b.subject).trim() : `Re: [Case #${c.case_number}] ${c.subject}`).replace(/[\r\n]+/g, ' ');
      const full = `${text}\n\n${me.display_name}`;
      const tenantId = (await db.query(`SELECT current_tenant_id() AS t`)).rows[0].t;
      const m = (await db.query(
        `INSERT INTO email_message (tenant_id, case_id, contact_id, to_email, from_email, subject, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [tenantId, c.id, c.contact_id, ct.email, email.from, subject, full])).rows[0];
      return { caseNumber: c.case_number as number, messageId: m.id as string, to: ct.email as string, subject, full, status: c.status as string };
    });

    let provider: { id: string } | undefined;
    let failure: string | undefined;
    try {
      provider = await email!.send({ from: email!.from, to: prep.to, subject: prep.subject, text: prep.full, replyTo: email!.caseReplyTo ? email!.caseReplyTo(prep.caseNumber) : email!.replyTo });
    } catch (e) {
      failure = e instanceof EmailError ? e.message : 'The email could not be sent.';
      if (!(e instanceof EmailError)) req.log.error(e);
    }

    const out = await authed(req, async (db, userId) => {
      if (failure) {
        await db.query(`UPDATE email_message SET status = 'failed', error = $2 WHERE id = $1`, [prep.messageId, failure.slice(0, 500)]);
        return { failed: failure };
      }
      await db.query(`UPDATE email_message SET status = 'sent', sent_at = now(), provider_message_id = $2 WHERE id = $1`, [prep.messageId, provider!.id]);
      const tenantId = (await db.query(`SELECT current_tenant_id() AS t`)).rows[0].t;
      await db.query(`INSERT INTO case_comment (tenant_id, case_id, author_user_id, body, is_public, via_email) VALUES ($1, $2, $3, $4, true, true)`, [tenantId, id, userId, text]);
      const next = b.status ?? (['new', 'open'].includes(prep.status) ? 'pending customer' : undefined);
      if (next && next !== prep.status) {
        // Setting the status after a reply is a convenience. Without edit access the reply still goes out.
        const ok = (await db.query(`SELECT can_do($1::uuid, 'case', 'edit') AS ok`, [userId])).rows[0].ok;
        if (ok) await db.query(`UPDATE support_case SET status = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, next]);
      }
      return { sent_to: prep.to, message_id: prep.messageId };
    });

    if ('failed' in out) throw new ApiError(502, 'email_failed', `The email was not sent. ${out.failed}`);
    return reply.status(201).send(out);
  });
}
