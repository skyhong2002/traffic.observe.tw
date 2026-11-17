CREATE TABLE queue_canaries (
  id VARCHAR(64) PRIMARY KEY,
  started_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  rolled_back_at DATETIME NULL,
  reason VARCHAR(128) NULL
);
ALTER TABLE sends ADD COLUMN queue_decision JSON NULL;
