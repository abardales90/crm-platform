-- 0014 inbound email: customer replies and new messages are kept next to the emails we send.

ALTER TABLE email_message ADD COLUMN direction text NOT NULL DEFAULT 'out' CHECK (direction IN ('out', 'in'));
ALTER TABLE email_message DROP CONSTRAINT email_message_status_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_status_check CHECK (status IN ('queued', 'sent', 'failed', 'received'));
-- The email service may deliver the same message twice. This makes the second one a no-op.
CREATE UNIQUE INDEX email_message_inbound_uq ON email_message (tenant_id, provider_message_id)
  WHERE direction = 'in' AND provider_message_id IS NOT NULL;
