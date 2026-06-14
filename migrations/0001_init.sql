-- LVX content store. Holds the live, editable docs behind the 360 tour product
-- (tours, floorplans, flat-video pin sets) plus an append-only revision log so
-- a bad authoring save can be rolled back.
--
-- Apply with:  wrangler d1 migrations apply lvx-content --remote

CREATE TABLE IF NOT EXISTS doc (
  kind       TEXT    NOT NULL,   -- 'tour' | 'plan' | 'pinset'
  id         TEXT    NOT NULL,   -- tour.slug | plan.tourSlug | pinset.uid
  body       TEXT    NOT NULL,   -- the entity, serialized as JSON
  updated_at INTEGER NOT NULL,   -- epoch milliseconds
  updated_by TEXT,               -- Access email of the last author
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS revision (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  doc_id     TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS revision_by_doc
  ON revision (kind, doc_id, id DESC);
