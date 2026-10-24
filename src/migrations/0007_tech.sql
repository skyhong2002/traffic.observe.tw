-- Technologies seen on each site's homepage (moved from blog's blog_tech_scans, keyed by domain instead of blog).
-- status/error_code/http_status/last_attempt_at describe the latest attempt; observed_at, source_url, rule_version
-- and detections are the latest successful snapshot, kept through later failures. origin: 'traffic' for our own
-- scans, 'blog' for snapshots imported from blog.observe.tw until we scan the site ourselves.
CREATE TABLE tech_scans (
  domain VARCHAR(253) NOT NULL PRIMARY KEY,
  status VARCHAR(16) NOT NULL,
  error_code VARCHAR(16) NULL,
  http_status INT NULL,
  last_attempt_at DATETIME NOT NULL,
  failures INT NOT NULL DEFAULT 0,
  observed_at DATETIME NULL,
  source_url VARCHAR(1024) NULL,
  rule_version VARCHAR(64) NULL,
  detections JSON NULL,
  origin VARCHAR(16) NOT NULL DEFAULT 'traffic',
  KEY tech_scans_attempt (last_attempt_at)
);
CREATE TABLE tech_runs (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  due INT NOT NULL DEFAULT 0,
  sent INT NOT NULL DEFAULT 0,
  ok INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL
);
