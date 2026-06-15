-- Capture projects: a folder per shoot/listing that holds ALL its files (videos,
-- stills, telemetry) and drives cloud processing → map + floor + tour. This is
-- the organizing unit for the capture-to-post workflow.
--
-- Apply with:  wrangler d1 migrations apply lvx-content --remote

CREATE TABLE IF NOT EXISTS project (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,   -- url-safe; also the tour/plan slug it feeds
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',  -- draft|processing|review|published
  tour_slug   TEXT,                   -- tour this project produces (defaults to slug)
  notes       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT
);

CREATE TABLE IF NOT EXISTS project_file (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  role         TEXT NOT NULL,         -- video|still|telemetry|other
  r2_key       TEXT NOT NULL,
  filename     TEXT,
  content_type TEXT,
  bytes        INTEGER,
  created_at   INTEGER NOT NULL,
  created_by   TEXT
);

CREATE INDEX IF NOT EXISTS project_file_by_project
  ON project_file (project_id, created_at ASC);
