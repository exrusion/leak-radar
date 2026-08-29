-- Sources: individual accounts/authors we've seen post leak-related content.
-- Trust score is a rolling 0-100 estimate of how often their claims pan out.
CREATE TABLE IF NOT EXISTS sources (
  id SERIAL PRIMARY KEY,
  platform TEXT NOT NULL,           -- 'reddit', 'twitter', 'discord'
  handle TEXT NOT NULL,             -- username/author on that platform
  trust_score NUMERIC DEFAULT 50,   -- 0-100, starts neutral
  claims_confirmed INTEGER DEFAULT 0,
  claims_debunked INTEGER DEFAULT 0,
  account_created_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform, handle)
);

-- Items: raw ingested posts/comments/tweets.
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,        -- platform's own post/comment id
  source_id INTEGER REFERENCES sources(id),
  title TEXT,
  body TEXT,
  url TEXT,
  permalink TEXT,
  posted_at TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  -- raw engagement snapshot at fetch time
  upvotes INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  UNIQUE (platform, external_id)
);

-- Engagement snapshots over time, so we can compute velocity (virality).
CREATE TABLE IF NOT EXISTS engagement_snapshots (
  id SERIAL PRIMARY KEY,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ DEFAULT now(),
  upvotes INTEGER,
  comment_count INTEGER
);

-- Computed scores per item. Recomputed periodically as engagement/corroboration changes.
CREATE TABLE IF NOT EXISTS scores (
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  credibility_score NUMERIC,        -- 0-100
  virality_score NUMERIC,           -- 0-100
  corroboration_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'unverified', -- 'unverified', 'corroborated', 'confirmed', 'debunked'
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Links between items judged to be about the same underlying claim (for corroboration scoring).
CREATE TABLE IF NOT EXISTS claim_clusters (
  id SERIAL PRIMARY KEY,
  label TEXT,                       -- short human/AI-generated description of the claim
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claim_cluster_items (
  cluster_id INTEGER REFERENCES claim_clusters(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (cluster_id, item_id)
);

-- Votes: one vote per (item, IP) so a single visitor can't spam thumbs up/down.
-- IP is stored as a salted hash, never raw, to avoid keeping identifying data.
CREATE TABLE IF NOT EXISTS votes (
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  ip_hash TEXT NOT NULL,
  direction TEXT NOT NULL,          -- 'up' or 'down'
  voted_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (item_id, ip_hash)
);

CREATE INDEX IF NOT EXISTS idx_items_posted_at ON items (posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_scores_virality ON scores (virality_score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_credibility ON scores (credibility_score DESC);
