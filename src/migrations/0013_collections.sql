-- Persist monthly work independently of the calendar and worker restarts.
CREATE TABLE collection_months (
  month CHAR(6) PRIMARY KEY,
  created_at DATETIME NOT NULL
);
CREATE TABLE collection_domains (
  month CHAR(6) NOT NULL,
  domain VARCHAR(253) NOT NULL,
  enrolled_at DATETIME NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  old_month_attempts INT NOT NULL DEFAULT 0,
  last_attempt_at DATETIME NULL,
  last_result VARCHAR(32) NULL,
  PRIMARY KEY (month, domain)
);
CREATE TABLE collection_priorities (
  domain VARCHAR(253) PRIMARY KEY,
  priority TINYINT NOT NULL,
  updated_at DATETIME NOT NULL,
  updated_by VARCHAR(255) NOT NULL
);
ALTER TABLE sends ADD COLUMN target_month CHAR(6) NULL, ADD COLUMN response_meta JSON NULL;
