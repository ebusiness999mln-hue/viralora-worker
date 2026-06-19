// Railway entrypoint. Boots the render_jobs poller (worker.js — both handlers:
// auto-clips + hyperframes) and exposes a health endpoint so Railway keeps the
// service up (Dockerfile EXPOSE 3000).
require('dotenv').config()
const express = require('express')

require('./worker') // starts the poll loop on require

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok' }))
const port = process.env.PORT || 3000
app.listen(port, () => console.log(`viralora-worker health on :${port}`))
