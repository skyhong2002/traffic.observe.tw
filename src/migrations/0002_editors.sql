-- Signed-in editors (TRAFFIC_ADMIN_EMAILS) and the domains they track by hand.
CREATE TABLE sessions (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  KEY sessions_expires (expires_at)
);
-- Who added a watch, and why; set for the 'manual' requester.
ALTER TABLE watches ADD COLUMN added_by VARCHAR(255) NULL, ADD COLUMN note VARCHAR(255) NULL;
CREATE TABLE watch_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at DATETIME NOT NULL,
  email VARCHAR(255) NOT NULL,
  action VARCHAR(16) NOT NULL,
  domain VARCHAR(253) NOT NULL,
  refresh_days INT NULL,
  note VARCHAR(255) NULL,
  KEY watch_log_domain (domain)
);
