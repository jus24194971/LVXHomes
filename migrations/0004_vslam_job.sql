-- VSLAM jobs: one row per "upload a 360 video → cloud floor plan" run. The
-- Studio creates it (status processing) and triggers Modal; Modal's callback
-- flips it to ready (with the produced plan + base R2 keys) or failed.
--
-- Apply with:  wrangler d1 migrations apply lvx-content --remote

CREATE TABLE IF NOT EXISTS vslam_job (
  id          TEXT PRIMARY KEY,   -- random job id
  slug        TEXT NOT NULL,      -- target tour/plan slug the floor binds to
  r2_key      TEXT NOT NULL,      -- the uploaded source video in R2
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued|processing|ready|failed
  scale       REAL,               -- metres per SLAM unit (optional; refine in Studio)
  plan_key    TEXT,               -- R2 key of the produced plan.json
  base_key    TEXT,               -- R2 key of the produced interior base image
  error       TEXT,               -- failure message when status = failed
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT
);

CREATE INDEX IF NOT EXISTS vslam_job_by_slug
  ON vslam_job (slug, created_at DESC);
