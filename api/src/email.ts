// Outbound email. The app talks to one small interface, so the provider can change without touching the rest.

export type OutgoingEmail = { from: string; to: string; subject: string; text: string; replyTo?: string };
export type SendResult = { id: string };
export type EmailSender = (msg: OutgoingEmail) => Promise<SendResult>;

export type EmailConfig = { send: EmailSender; from: string; replyTo?: string };

export class EmailError extends Error {}

// Resend: https://resend.com/docs/api-reference/emails/send-email
export function resendSender(apiKey: string): EmailSender {
  return async (msg) => {
    let res: Response;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.replyTo ? { reply_to: msg.replyTo } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new EmailError('The email service did not answer. Try again in a minute.');
    }
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new EmailError(String(j?.message || `The email service refused the message (${res.status}).`));
    return { id: String(j.id ?? '') };
  };
}

// Pulls the address out of "Name <a@b.com>" or a bare address.
export const addressOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim();
