// Railway entrypoint. Binds the HTTP server FIRST (health + /render), THEN loads
// the worker (poll loop + handlers). Order matters: requiring the worker pulls in
// puppeteer-core + supabase + the poll loop, and if any of that throws at load,
// app.listen would never run → Railway shows "Application failed to respond" (502).
// Listening first guarantees /health is always green even if a handler module breaks.
require('dotenv').config()
const express = require('express')

// Keep the process alive through a stray async error — one unhandled rejection in
// a job (yt-dlp/ffmpeg/network) would otherwise kill the container and 502 every
// request until redeploy. Log, stay up.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e))
process.on('uncaughtException', (e) => console.error('uncaughtException:', e))

const app = express()
app.use(express.json())
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// Load the worker AFTER the server is defined and non-fatally. A failure here
// (missing dep, bad env) must not stop the HTTP server from binding.
let runJob = null
try {
  runJob = require('./worker').runJob // also starts the poll loop on require
} catch (e) {
  console.error('worker module failed to load — /render disabled, server still up:', e)
}

// Direct trigger from Vercel (auto-clips/hyperframes enqueue). Run the job now
// instead of waiting for the poll. Respond immediately — processing is long.
app.post('/render', (req, res) => {
  const jobId = req.body && req.body.jobId
  if (!jobId) return res.status(400).json({ error: 'jobId required' })
  if (!runJob) return res.status(503).json({ error: 'worker unavailable' })
  res.json({ ok: true })
  runJob(jobId).catch((e) => console.error('runJob', jobId, e.message))
})

// Bind 0.0.0.0 explicitly — Railway routes to the container's external interface;
// the default bind can leave the port unreachable and surface as a 502.
const port = process.env.PORT || 3000
app.listen(port, '0.0.0.0', () => console.log(`viralora-worker on :${port}`))
