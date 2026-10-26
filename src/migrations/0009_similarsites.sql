-- What similarsites.com lists as similar to each tracked site, with its similarity grade (0..1). One row per
-- (domain, similar) pair from the latest successful fetch; a later success replaces that domain's rows. The
-- similar site's category, rank in its top country, monthly visits and blurb are as similarsites.com showed them.
CREATE TABLE similarsites_edges (
  domain VARCHAR(253) NOT NULL,
  similar VARCHAR(253) NOT NULL,
  similarity_rank INT NOT NULL,
  grade DOUBLE NOT NULL,
  category VARCHAR(64) NULL,
  top_country_rank INT NULL,
  total_visits BIGINT NULL,
  description VARCHAR(500) NULL,
  fetched_at DATETIME NOT NULL,
  PRIMARY KEY (domain, similar),
  KEY similarsites_similar (similar)
);
-- Latest attempt per domain; status 'ok', 'not-found' (similarsites.com has no page) or 'failed'.
CREATE TABLE similarsites_state (
  domain VARCHAR(253) NOT NULL PRIMARY KEY,
  status VARCHAR(16) NOT NULL,
  http_status INT NULL,
  last_attempt_at DATETIME NOT NULL,
  fetched_at DATETIME NULL,
  failures INT NOT NULL DEFAULT 0,
  KEY similarsites_attempt (last_attempt_at)
);
