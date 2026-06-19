# viralora-worker

Polls Supabase `render_jobs` and processes two job kinds. Vercel enqueues; this
worker processes. FFmpeg/Chrome can't run on Vercel serverless — they run here.

## Handlers
- **auto-clips** (`lib/autoclips.js`) — FFmpeg + Qwen. Downloads `videoUrl`, Qwen
  picks viral moments, FFmpeg cuts each, Qwen scores + captions, uploads clips to
  the `clips` bucket. Writes `result = { clips:[{ url, start, end, caption, score, reasons }] }`.
- **hyperframes** (`lib/hyperframes.js`) — captions + animations. Builds a
  deterministic 1080×1920 page, captures it frame-by-frame with headless Chrome,
  encodes to MP4, uploads to the `videos` bucket. Writes `asset_url`.

## Job contract (`render_jobs.script`)
```
{ kind: "auto-clips",  videoUrl, title, duration }
{ kind: "hyperframes", scenes:[ScriptScene], style, durationSeconds }
```
Worker sets `status` pending → processing → completed | failed.

## Run
```
cp .env.example .env   # fill in keys
npm install
npm run selftest       # offline logic check
npm start              # poll loop
```
Deploy on Railway via the Dockerfile (ships ffmpeg + chromium). Buckets `videos`
and `clips` must be public. Run `render_jobs.sql` once.
