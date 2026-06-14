-- Embed grants: each row is one issued, revocable embed code (branded or not)
-- for a tour or a film. Embedding requires a valid grant — no grant, no embed —
-- so an agent needs a code you generate in the Studio.
--
-- Apply with:  wrangler d1 migrations apply lvx-content --remote

CREATE TABLE IF NOT EXISTS embed_grant (
  id          TEXT PRIMARY KEY,   -- random unguessable token (the embed code)
  kind        TEXT NOT NULL,      -- 'tour' | 'film'
  ref         TEXT NOT NULL,      -- tour slug | film Stream uid
  branded     INTEGER NOT NULL DEFAULT 1,  -- 1 = show LVX mark, 0 = unbranded
  label       TEXT,               -- optional: who it's for (agent / brokerage / address)
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);

CREATE INDEX IF NOT EXISTS grant_by_ref
  ON embed_grant (kind, ref, created_at DESC);
