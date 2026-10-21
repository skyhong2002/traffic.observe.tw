-- Every Similarweb month and profile ever seen (Similarweb itself only returns the
-- latest three months and one profile), the domains services want watched, the
-- fetch state and request log, and the imported rows of the GeneHong sheet.

CREATE TABLE traffic_months (
  domain VARCHAR(253) NOT NULL,
  month CHAR(6) NOT NULL,
  visits BIGINT NOT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'similarweb',
  first_seen_at DATETIME NOT NULL,
  fetched_at DATETIME NOT NULL,
  PRIMARY KEY (domain, month),
  KEY traffic_months_month (month)
);

-- One profile (countries, channels, engagement, ranks) per domain and month.
CREATE TABLE traffic_profiles (
  domain VARCHAR(253) NOT NULL,
  month CHAR(6) NOT NULL,
  profile JSON NOT NULL,
  first_seen_at DATETIME NOT NULL,
  fetched_at DATETIME NOT NULL,
  PRIMARY KEY (domain, month),
  KEY traffic_profiles_month (month)
);

-- Who wants a domain. kind 'watch' is a standing list (tag's outlets, the sheet)
-- refreshed every refresh_days; 'traffic' and 'similar_sites' are one-off lookups
-- (blog), fetched once per submission.
CREATE TABLE watches (
  requester VARCHAR(16) NOT NULL,
  domain VARCHAR(253) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  requested_at DATETIME NOT NULL,
  refresh_days INT NULL,
  PRIMARY KEY (requester, domain, kind),
  KEY watches_domain (domain)
);

-- Per-domain fetch state. last_response_at: Similarweb answered (maybe without
-- visits); last_success_at: it answered with visits. result is the latest summary
-- (category, similar sites) for the request API.
CREATE TABLE fetch_state (
  domain VARCHAR(253) NOT NULL PRIMARY KEY,
  last_attempt_at DATETIME NULL,
  last_response_at DATETIME NULL,
  last_success_at DATETIME NULL,
  failures INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NULL,
  last_error VARCHAR(255) NULL,
  refused_at DATETIME NULL,
  result JSON NULL
);

-- Every request sent to Similarweb.
CREATE TABLE sends (
  id INT AUTO_INCREMENT PRIMARY KEY,
  domain VARCHAR(253) NOT NULL,
  at DATETIME NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  http_status INT NULL,
  KEY sends_at (at)
);

CREATE TABLE runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  budget INT NOT NULL,
  sent INT NOT NULL DEFAULT 0,
  ok INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  refused TINYINT NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL
);

-- The GeneHong sheet as imported, one row per sheet row and month tab. Shares are
-- fractions (0.2387), visits in millions as the sheet has them.
CREATE TABLE sheet_rows (
  month CHAR(6) NOT NULL,
  row_no INT NOT NULL,
  group_label VARCHAR(32) NULL,
  topics VARCHAR(128) NULL,
  name VARCHAR(128) NOT NULL,
  url VARCHAR(512) NULL,
  domain VARCHAR(253) NULL,
  visits DOUBLE NULL,
  adjusted TINYINT NOT NULL DEFAULT 0,
  search_share DOUBLE NULL,
  ai_share DOUBLE NULL,
  taiwan_share DOUBLE NULL,
  raw JSON NOT NULL,
  imported_at DATETIME NOT NULL,
  PRIMARY KEY (month, row_no),
  KEY sheet_rows_domain (domain)
);
