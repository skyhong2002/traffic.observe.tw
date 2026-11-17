-- Manual evidence stays separate from automated tech_scans and survives refreshes.
CREATE TABLE tech_manual (
  domain VARCHAR(253) PRIMARY KEY,
  products JSON NOT NULL,
  source_url VARCHAR(2048) NOT NULL,
  observed_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);
CREATE TABLE tech_manual_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  domain VARCHAR(253) NOT NULL,
  editor VARCHAR(255) NOT NULL,
  action VARCHAR(16) NOT NULL,
  products JSON NOT NULL,
  source_url VARCHAR(2048) NULL,
  observed_at DATETIME NULL,
  changed_at DATETIME NOT NULL,
  KEY domain_changed (domain, changed_at)
);
