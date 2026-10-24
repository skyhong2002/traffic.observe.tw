-- Months an editor copied by hand from the Similarweb platform (pro.similarweb.com)
-- for domains its free data endpoint has no estimate for (it answers 0), such as
-- tw.news.yahoo.com. Shares are fractions (0.3645), null when not entered.
CREATE TABLE manual_months (
  domain VARCHAR(253) NOT NULL,
  month CHAR(6) NOT NULL,
  visits BIGINT NOT NULL,
  search_share DOUBLE NULL,
  ai_share DOUBLE NULL,
  taiwan_share DOUBLE NULL,
  updated_at DATETIME NOT NULL,
  updated_by VARCHAR(255) NOT NULL,
  PRIMARY KEY (domain, month)
);
CREATE TABLE manual_months_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  domain VARCHAR(253) NOT NULL,
  month CHAR(6) NOT NULL,
  at DATETIME NOT NULL,
  email VARCHAR(255) NOT NULL,
  before_value JSON NULL,
  after_value JSON NULL,
  KEY manual_months_log_domain (domain)
);
