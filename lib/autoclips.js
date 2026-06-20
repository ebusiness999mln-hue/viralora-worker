// Auto Clips handler — FFmpeg + Qwen.
// Downloads the source video, asks Qwen (OpenRouter) for the most viral moments,
// cuts each with FFmpeg, scores + captions each clip with Qwen, uploads the clips
// to Supabase Storage. Returns { clips: [{ url, start, end, caption, score, reasons }] }.
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { uploadPublic } = require('./storage')

const BUCKET = 'clips'
const MODEL = 'qwen/qwen-2.5-72b-instruct'

// ── Qwen via OpenRouter (forced JSON) ──
async function qwenJSON(system, user) {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY not set')
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error?.message || `OpenRouter ${r.status}`)
  return JSON.parse(j.choices[0].message.content)
}

// ── ffmpeg helpers ──
function run(bin, args) {
  return new Promise((res, rej) => {
    const p = spawn(bin, args)
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', rej)
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${bin} exited ${c}: ${err.slice(-400)}`))))
  })
}
function probeDuration(file) {
  return new Promise((res, rej) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', rej)
    p.on('close', (c) => (c === 0 ? res(parseFloat(out) || 0) : rej(new Error('ffprobe failed'))))
  })
}

// Job: { videoUrl, title, duration }. Returns { clips }.
async function renderAutoClips(job, supabase) {
  const { videoUrl, title, duration: hinted } = job.script || {}
  if (!videoUrl) throw new Error('videoUrl missing')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-'))
  const input = path.join(dir, 'in.mp4')
  try {
    // yt-dlp handles YouTube/social URLs *and* direct mp4 links; cap at 720p / first 10 min.
    await run('yt-dlp', ['-f', 'best[height<=720]', '--download-sections', '*0-600',
      '--force-overwrites', '-o', input, videoUrl])

    const duration = (await probeDuration(input)) || Number(hinted) || 0

    const { moments } = await qwenJSON(
      'Pick the 10 most viral-worthy moments. Return JSON {moments:[{start,end,reason}]}. start/end in seconds, each clip 15-60s, within the video length.',
      `Video "${title || 'untitled'}" is ${Math.round(duration)}s long.`
    )
    const list = (Array.isArray(moments) ? moments : [])
      .map((m) => ({ start: Math.max(0, +m.start || 0), end: Math.min(duration || +m.end || 0, +m.end || 0), reason: m.reason || '' }))
      .filter((m) => m.end > m.start)
      .slice(0, 10)

    const clips = []
    for (let i = 0; i < list.length; i++) {
      const m = list[i]
      const out = path.join(dir, `clip-${i}.mp4`)
      // re-encode for a frame-accurate cut (stream-copy snaps to keyframes)
      await run('ffmpeg', ['-ss', `${m.start}`, '-i', input, '-t', `${m.end - m.start}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', '-y', out])

      const url = await uploadPublic(supabase, BUCKET, `${job.id}/clip-${i}.mp4`, fs.readFileSync(out), 'video/mp4')

      const scored = await qwenJSON(
        'Score viral potential 0-100 and write a punchy caption. Return JSON {score,caption,reasons[]}.',
        `Clip moment: ${m.reason}. Length ${Math.round(m.end - m.start)}s.`
      ).catch(() => ({ score: 50, caption: m.reason, reasons: [m.reason] }))

      clips.push({
        url, start: m.start, end: m.end, reason: m.reason,
        caption: scored.caption || m.reason,
        score: Math.round(scored.score || 0),
        reasons: scored.reasons || [],
      })
    }
    clips.sort((a, b) => b.score - a.score)
    return { clips }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

module.exports = { renderAutoClips }
