-- Original automatic, spreadsheet, and manual records remain in their existing tables.
CREATE TABLE contributor_observations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_node VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  domain VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_month CHAR(6) NOT NULL,
  fetched_at DATETIME(3) NOT NULL,
  source_version VARCHAR(64) NOT NULL,
  schema_version SMALLINT NOT NULL,
  response_status SMALLINT NOT NULL,
  fields JSON NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload JSON NOT NULL,
  accepted_at DATETIME(3) NOT NULL,
  UNIQUE KEY observation_identity (source_node, domain, target_month, payload_hash),
  KEY domain_month (domain, target_month)
);
CREATE TABLE contributor_canonical (
  domain VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_month CHAR(6) NOT NULL,
  observation_id BIGINT NULL,
  reason VARCHAR(512) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (domain, target_month)
);
-- Rejections contain safe error codes, never rejected bodies or credentials.
CREATE TABLE contributor_rejections (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  source_node VARCHAR(64) NOT NULL,
  reason VARCHAR(64) NOT NULL,
  field VARCHAR(64) NULL,
  received_at DATETIME NOT NULL
);
