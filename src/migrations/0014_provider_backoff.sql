-- Shared, durable recovery state. Retrying never changes provider identity or endpoint.
CREATE TABLE similarweb_backoff (
  id TINYINT PRIMARY KEY,
  phase VARCHAR(16) NOT NULL,
  refusals INT NOT NULL DEFAULT 0,
  successes INT NOT NULL DEFAULT 0,
  http_status INT NULL,
  retry_source VARCHAR(24) NULL,
  next_attempt_at DATETIME NULL,
  provider_retry_at DATETIME NULL,
  last_refused_at DATETIME NULL,
  updated_at DATETIME NOT NULL
);
ALTER TABLE sends ADD COLUMN recovery_probe TINYINT NOT NULL DEFAULT 0;
