const express = require('express')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const puppeteer = require('puppeteer-core')
const { createClient } = require('@supabase/supabase-js')

const FPS = 30
const W = 1080
const H = 1920
const BUCKET = 'videos'

const app = express()
app.use(express.json({ limit: '2mb' }))

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.post('/render', async (req, res) => {
  const { script, style, duration } = req.body || {}
  if (!script || typeof script !== 'string') return res.status(400).json({ error: 'script required' })
  try {
    const videoUrl = await render({ script, style: style || {}, duration: clampDuration(duration) })
    res.json({ videoUrl })
  } catch (err) {
    console.error('render failed:', err)
    res.status(500).json({ error: 'render failed' })
  }
})

// ── Pipeline ────────────────────────────────────────────────────────────────
// script -> timed scenes -> deterministic HTML -> chromium frames -> ffmpeg mp4
// -> Supabase storage -> public URL.
async function render({ script, style, duration }) {
  const scenes = splitScript(script, duration)
  const html = buildHtml(scenes, style)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'))
  try {
    await captureFrames(html, duration, dir)
    const mp4 = path.join(dir, 'out.mp4')
    await encode(dir, mp4)
    return await upload(mp4)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function clampDuration(d) {
  const n = Number(d)
  if (!Number.isFinite(n) || n <= 0) return 15
  // ponytail: hard cap. Synchronous render in the request — long videos blow
  // request timeouts. Upgrade path: bullmq job + /status polling (deps present).
  return Math.min(Math.max(n, 2), 60)
}

// Even split of the script into scene captions across the duration.
// ponytail: naive sentence split + equal time slices. Upgrade path: reuse the
// Groq scene-timing from viralora /api/video/script for weighted durations.
function splitScript(script, duration) {
  const parts = script.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)
  const chunks = parts.length ? parts : [script.trim()]
  const slice = duration / chunks.length
  return chunks.map((text, i) => ({ text, start: i * slice, end: (i + 1) * slice }))
}

const FONT_STACK = {
  Inter: "'Inter',system-ui,sans-serif",
  Montserrat: "'Montserrat',system-ui,sans-serif",
  Oswald: "'Oswald','Arial Narrow',sans-serif",
  'Bebas Neue': "'Bebas Neue',Impact,sans-serif",
}
const SIZE_PX = { Small: 48, Medium: 64, Large: 84, XL: 108 }
const WEIGHT_NUM = { Normal: 400, Bold: 700, Black: 900 }

function esc(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

// Self-contained 1080x1920 page. window.frameAt(t) shows the active scene and
// drives its entry animation from t — deterministic so each captured frame is a
// pure function of t (no wall-clock, no external timeline lib).
function buildHtml(scenes, style) {
  const font = FONT_STACK[style.font] || FONT_STACK.Inter
  const size = SIZE_PX[style.size] || SIZE_PX.Large
  const weight = WEIGHT_NUM[style.weight] || WEIGHT_NUM.Black
  const textColor = style.textColor || '#FFFFFF'
  const outline = style.outlineColor || '#000000'
  const accent = style.accent || '#4A9EFF'
  const bg = style.background === 'White' ? '#F0EEE8'
    : style.background === 'Gradient' ? `linear-gradient(135deg,${accent},#05050A)`
    : style.background === 'Custom' ? (style.customBg || '#05050A')
    : '#05050A'
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:${bg}}
.frame{width:${W}px;height:${H}px;display:flex;align-items:flex-end;justify-content:center;padding:90px;font-family:${font}}
.cap{display:none;color:${textColor};-webkit-text-stroke:3px ${outline};paint-order:stroke fill;
  font-size:${size}px;font-weight:${weight};text-align:center;line-height:1.05;text-transform:uppercase;
  max-width:90%;border-bottom:6px solid ${accent};padding-bottom:24px}
</style></head><body>
<div class="frame">${scenes.map((s, i) => `<div class="cap" id="c${i}">${esc(s.text)}</div>`).join('')}</div>
<script>
var SCENES=${JSON.stringify(scenes.map((s) => ({ start: s.start, end: s.end })))};
window.frameAt=function(t){
  for(var i=0;i<SCENES.length;i++){
    var el=document.getElementById('c'+i),s=SCENES[i];
    if(t>=s.start&&t<s.end){
      var p=Math.min((t-s.start)/0.4,1); // 0.4s pop-in
      el.style.display='block';
      el.style.opacity=p;
      el.style.transform='scale('+(0.6+0.4*p)+')';
    }else{el.style.display='none'}
  }
};
window.frameAt(0);
</script></body></html>`
}

async function captureFrames(html, duration, dir) {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', `--window-size=${W},${H}`],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: W, height: H })
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const total = Math.round(duration * FPS)
    for (let i = 0; i < total; i++) {
      await page.evaluate((t) => window.frameAt(t), i / FPS)
      await page.screenshot({ path: path.join(dir, `f${String(i).padStart(5, '0')}.png`) })
    }
  } finally {
    await browser.close()
  }
}

function encode(dir, out) {
  // ffmpeg ships in the Docker image.
  return run('ffmpeg', [
    '-y', '-framerate', String(FPS), '-i', path.join(dir, 'f%05d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
  ])
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code))))
  })
}

async function upload(mp4) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  const admin = createClient(url, key)
  await admin.storage.createBucket(BUCKET, { public: true }).catch(() => {})
  // Deterministic-render env forbids Date.now/random; name by content hash.
  const buf = fs.readFileSync(mp4)
  const name = `render-${hash(buf)}.mp4`
  const { error } = await admin.storage.from(BUCKET).upload(name, buf, { contentType: 'video/mp4', upsert: true })
  if (error) throw error
  return admin.storage.from(BUCKET).getPublicUrl(name).data.publicUrl
}

function hash(buf) {
  return require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 16)
}

// ── Self-check (node server.js --selftest) ────────────────────────────────────
if (process.argv.includes('--selftest')) {
  const a = require('assert')
  let s = splitScript('Hook them fast. Post at peak. Follow now!', 15)
  a.strictEqual(s.length, 3)
  a.strictEqual(s[0].start, 0)
  a.strictEqual(s[2].end, 15)
  a.ok(buildHtml(s, {}).includes('frameAt'))
  a.strictEqual(clampDuration(999), 60)
  a.strictEqual(clampDuration('abc'), 15)
  console.log('selftest ok')
  process.exit(0)
}

app.listen(3000, () => console.log('Worker running on port 3000'))
// test deploy
