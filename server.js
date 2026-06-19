// Railway entrypoint. Boots the render_jobs poller (worker.js — both handlers:
// auto-clips + hyperframes) and exposes a health endpoint so Railway keeps the
// service up (Dockerfile EXPOSE 3000).
require('dotenv').config()
const express = require('express')

const { runJob } = require('./worker') // also starts the poll loop on require

const app = express()
app.use(express.json())
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// Direct trigger from Vercel (auto-clips/hyperframes enqueue). Run the job now
// instead of waiting for the poll. Respond immediately — processing is long.
app.post('/render', (req, res) => {
  const jobId = req.body && req.body.jobId
  if (!jobId) return res.status(400).json({ error: 'jobId required' })
  res.json({ ok: true })
  runJob(jobId).catch((e) => console.error('runJob', jobId, e.message))
})

const port = process.env.PORT || 3000
app.listen(port, () => console.log(`viralora-worker on :${port}`))
