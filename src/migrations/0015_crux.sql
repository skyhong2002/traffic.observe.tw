-- Chrome UX Report (CrUX) popularity rank magnitude per origin, from BigQuery's public
-- chrome-ux-report.country_<cc>.<YYYYMM> tables. One query returns the whole country, so every
-- month is stored whole: domains watched later are matched locally without querying again.
-- rank is a bucket ("top N": 1000, 5000, 10000, …), never an exact place, and is not visits.
CREATE TABLE crux_origins (
  country CHAR(2) CHARACTER SET ascii NOT NULL,
  month CHAR(6) CHARACTER SET ascii NOT NULL,
  host VARCHAR(253) CHARACTER SET ascii NOT NULL,
  `rank` INT NOT NULL,
  PRIMARY KEY (country, month, host),
  KEY crux_origins_rank (country, month, `rank`)
);

-- A month is listed here only once all of its origins are stored.
CREATE TABLE crux_months (
  country CHAR(2) CHARACTER SET ascii NOT NULL,
  month CHAR(6) CHARACTER SET ascii NOT NULL,
  origins INT NOT NULL,
  fetched_at DATETIME NOT NULL,
  PRIMARY KEY (country, month)
);

-- Per watched domain: the best rank among its own origins and its subdomains' (www.pixnet.net and
-- every *.pixnet.net blog count for pixnet.net). host is the origin that holds that rank.
CREATE TABLE crux_ranks (
  domain VARCHAR(253) NOT NULL,
  country CHAR(2) CHARACTER SET ascii NOT NULL,
  month CHAR(6) CHARACTER SET ascii NOT NULL,
  `rank` INT NOT NULL,
  host VARCHAR(253) CHARACTER SET ascii NOT NULL,
  PRIMARY KEY (domain, country, month),
  KEY crux_ranks_month (country, month)
);

-- Domains already matched against every month stored at checked_at (a domain absent from CrUX
-- has no crux_ranks rows but is still listed, so it is not matched again every day).
CREATE TABLE crux_domains (
  domain VARCHAR(253) NOT NULL,
  country CHAR(2) CHARACTER SET ascii NOT NULL,
  checked_at DATETIME NOT NULL,
  PRIMARY KEY (domain, country)
);

CREATE TABLE crux_runs (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  months INT NOT NULL DEFAULT 0,
  domains INT NOT NULL DEFAULT 0,
  bytes_processed BIGINT NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL
);
