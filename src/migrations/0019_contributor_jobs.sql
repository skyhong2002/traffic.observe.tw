CREATE TABLE contributor_nodes (
  source_node VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  source_version VARCHAR(64) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL
);
CREATE TABLE contributor_jobs (
  send_id BIGINT PRIMARY KEY,
  source_node VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  domain VARCHAR(253) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  claimed_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  consumed_at DATETIME(3) NULL,
  result MEDIUMTEXT NULL,
  KEY node_pending (source_node, completed_at, expires_at)
);
