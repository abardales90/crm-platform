-- 0015 comment channel: marks conversation entries that were an email (sent or received) so the case screen can label them.

ALTER TABLE case_comment ADD COLUMN via_email boolean NOT NULL DEFAULT false;
