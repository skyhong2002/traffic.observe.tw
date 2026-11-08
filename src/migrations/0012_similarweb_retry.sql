-- Provider cooldown survives worker restarts and is shared by every run.
ALTER TABLE fetch_state ADD COLUMN retry_after_at DATETIME NULL;
