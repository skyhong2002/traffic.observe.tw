-- Tags beyond the editors' list (site_metadata.topics, or the sheet's): AI suggestions sent by services
-- such as blog, tags readers add, reader votes, and admin overrides of a single tag. src/crowd.ts resolves them.
CREATE TABLE tag_assignments (
  domain VARCHAR(253) NOT NULL,
  tag VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  -- ai | community | admin
  source VARCHAR(16) NOT NULL,
  -- ai: active; community: candidate; admin: active (set) or hidden (hide)
  status VARCHAR(16) NOT NULL,
  reason TEXT NULL,
  -- A signed-in email, or service:<requester> for AI suggestions
  actor VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (domain, tag, source)
);
-- One vote per Google account (verified email) per tag; via is web or the service that forwarded it.
CREATE TABLE tag_votes (
  domain VARCHAR(253) NOT NULL,
  tag VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  voter VARCHAR(255) NOT NULL,
  vote TINYINT NOT NULL,
  via VARCHAR(16) NOT NULL,
  at DATETIME NOT NULL,
  PRIMARY KEY (domain, tag, voter),
  KEY tag_votes_voter (voter),
  CONSTRAINT tag_votes_value CHECK (vote IN (-1, 1))
);
CREATE TABLE tag_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at DATETIME NOT NULL,
  actor VARCHAR(255) NOT NULL,
  via VARCHAR(16) NOT NULL,
  action VARCHAR(16) NOT NULL,
  domain VARCHAR(253) NOT NULL,
  tag VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  detail JSON NULL,
  KEY tag_log_domain (domain)
);
