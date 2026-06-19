-- Run once in Supabase SQL editor. The local worker (worker.js) polls this table.
CREATE TABLE IF NOT EXISTS render_jobs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references profiles(id),
  script jsonb,
  style jsonb,
  status text default 'pending',
  asset_url text,
  error text,
  created_at timestamptz default now()
);
