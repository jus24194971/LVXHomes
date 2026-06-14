-- Media library: every video + pano the Studio manages (Stream films, R2 360
-- clips, R2 panos). Tours/films reference these by id or by the derived URL.
--
-- Apply with:  wrangler d1 migrations apply lvx-content --remote

CREATE TABLE IF NOT EXISTS asset (
  id           TEXT PRIMARY KEY,   -- uuid
  kind         TEXT NOT NULL,      -- 'film' (Stream) | 'video360' (R2) | 'pano' (R2)
  title        TEXT NOT NULL,
  status       TEXT NOT NULL,      -- 'uploading' | 'processing' | 'ready' | 'error'
  stream_uid   TEXT,               -- for kind='film'
  r2_key       TEXT,               -- for kind='video360' | 'pano'
  content_type TEXT,
  bytes        INTEGER,
  thumb_url    TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   TEXT
);

CREATE INDEX IF NOT EXISTS asset_browse
  ON asset (archived, kind, created_at DESC);
