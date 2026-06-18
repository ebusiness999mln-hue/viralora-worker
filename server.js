const express = require('express')
const app = express()
app.use(express.json())

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.post('/render', async (req, res) => {
  const { script, style, duration } = req.body || {}
  if (!script) return res.status(400).json({ error: 'script required' })

  try {
    // ponytail: render engine (HyperFrames -> chromium -> ffmpeg) not wired yet.
    // Dockerfile ships ffmpeg+chromium but no engine code/deps exist in this repo.
    // Returns a placeholder until the HyperFrames pipeline lands here.
    const videoUrl = await render({ script, style, duration })
    res.json({ videoUrl })
  } catch (err) {
    console.error('render failed:', err)
    res.status(500).json({ error: 'render failed' })
  }
})

async function render({ script, style, duration }) {
  // TODO: build HyperFrames composition from script/style/duration,
  // rasterize with chromium, encode with ffmpeg, upload, return public URL.
  return 'rendered video url'
}

app.listen(3000, () => console.log('Worker running on port 3000'))
