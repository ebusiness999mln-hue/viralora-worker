// HyperFrames handler — captions + animations.
// Builds a deterministic 1080x1920 page whose window.frameAt(t) shows the active
// caption and drives its pop-in from t (pure function of t — no wall clock), then
// captures it frame-by-frame with headless Chrome and encodes to MP4 via ffmpeg.
// Ported from the old server.js /render path.
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const puppeteer = require('puppeteer-core')
const { uploadPublic } = require('./storage')

const FPS = 30
const W = 1080
const H = 1920
const BUCKET = 'videos'

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

function clampDuration(d) {
  const n = Number(d)
  if (!Number.isFinite(n) || n <= 0) return 15
  // ponytail: hard 60s cap — capture is real-time-ish per frame; long videos
  // blow render time. Upgrade path: shard frames across workers.
  return Math.min(Math.max(n, 2), 60)
}

// Normalize Vercel ScriptScene[] -> [{text,start,end}]. Use real timings when
// present, else split the duration evenly.
function normalizeScenes(scenes, duration) {
  const list = (Array.isArray(scenes) ? scenes : []).map((s) => ({
    text: (s && (s.text || s.voiceover)) || '',
    start: Number(s && s.startTime),
    end: Number(s && s.endTime),
  })).filter((s) => s.text)
  const timed = list.every((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
  if (list.length && timed) return list
  const src = list.length ? list : [{ text: 'Your hook here' }]
  const slice = duration / src.length
  return src.map((s, i) => ({ text: s.text, start: i * slice, end: (i + 1) * slice }))
}

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

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' exited ' + code))))
  })
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
  return run('ffmpeg', [
    '-y', '-framerate', String(FPS), '-i', path.join(dir, 'f%05d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
  ])
}

// Job: { scenes, style, durationSeconds }. Returns the public MP4 url.
async function renderHyperFrames(job, supabase) {
  const s = job.script || {}
  const duration = clampDuration(s.durationSeconds)
  const scenes = normalizeScenes(s.scenes, duration)
  const html = buildHtml(scenes, s.style || {})
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-'))
  try {
    await captureFrames(html, duration, dir)
    const mp4 = path.join(dir, 'out.mp4')
    await encode(dir, mp4)
    const url = await uploadPublic(supabase, BUCKET, `render-${job.id}.mp4`, fs.readFileSync(mp4), 'video/mp4')
    return { asset_url: url }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

module.exports = { renderHyperFrames, buildHtml, normalizeScenes, clampDuration }
