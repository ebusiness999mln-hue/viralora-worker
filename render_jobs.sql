-- Run once in Supabase SQL editor. The worker (worker.js) polls this table.
CREATE TABLE IF NOT EXISTS render_jobs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id),
  script jsonb,      -- { kind: "auto-clips" | "hyperframes", ... }
  style jsonb,
  status text default 'pending',
  asset_url text,    -- hyperframes output (MP4 url)
  result jsonb,      -- auto-clips output ({ clips: [...] })
  error text,
  created_at timestamptz default now()
);

-- For existing tables created before result/index existed:
ALTER TABLE render_jobs ADD COLUMN IF NOT EXISTS result jsonb;
CREATE INDEX IF NOT EXISTS render_jobs_status_idx ON render_jobs (status);
