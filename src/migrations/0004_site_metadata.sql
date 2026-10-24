-- Manual values are separate from imported rows, so reimporting cannot overwrite edits.
CREATE TABLE site_metadata (
  domain VARCHAR(253) NOT NULL PRIMARY KEY,
  name VARCHAR(128) NULL,
  topics JSON NULL,
  revision INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL,
  updated_by VARCHAR(255) NOT NULL
);
CREATE TABLE site_metadata_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  domain VARCHAR(253) NOT NULL,
  at DATETIME NOT NULL,
  email VARCHAR(255) NOT NULL,
  before_value JSON NOT NULL,
  after_value JSON NOT NULL,
  KEY site_metadata_log_domain (domain)
);
