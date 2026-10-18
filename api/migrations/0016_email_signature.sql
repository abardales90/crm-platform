-- 0016 email signature: each person's own signature, added to the bottom of emails they send.

ALTER TABLE user_preference ADD COLUMN email_signature text CHECK (length(email_signature) <= 1000);
