-- Cloudflare Radar POPULAR ranking per domain and reporting period (moved from tag's media_radar_ranks).
-- rank: exact place in the top 100; bucket: "top N"; bucket_lower_bound: ">N" (not in the top N).
CREATE TABLE radar_ranks (
  domain VARCHAR(253) NOT NULL,
  date_end DATETIME NOT NULL,
  date_start DATETIME NOT NULL,
  `rank` INT NULL,
  bucket INT NULL,
  bucket_lower_bound INT NULL,
  first_seen_at DATETIME NOT NULL,
  fetched_at DATETIME NOT NULL,
  PRIMARY KEY (domain, date_end),
  KEY radar_ranks_date (date_end)
);
CREATE TABLE radar_state (
  domain VARCHAR(253) NOT NULL PRIMARY KEY,
  last_attempt_at DATETIME NULL,
  last_success_at DATETIME NULL,
  failures INT NOT NULL DEFAULT 0,
  last_error VARCHAR(255) NULL
);
CREATE TABLE radar_runs (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  sent INT NOT NULL DEFAULT 0,
  ok INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  blocked TINYINT NOT NULL DEFAULT 0,
  note VARCHAR(255) NULL
);
