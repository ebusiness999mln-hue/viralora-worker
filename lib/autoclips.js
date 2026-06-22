// Auto Clips handler — FAST pipeline (no full download, no re-encode).
// 1. yt-dlp prints duration + grabs auto-subs (metadata only, no video).
// 2. Qwen (OpenRouter) picks the 5 most viral moments from title+transcript.
// 3. yt-dlp --download-sections pulls ONLY those segments in one call.
// 4. Upload each to Supabase Storage.
// Returns { clips: [{ url, start, end, caption, score, reasons }] }.
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

function run(bin, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(bin, args, opts)
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', rej)
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${bin} exited ${c}: ${err.slice(-400)}`))))
  })
}

// Video length in seconds — metadata only, no download.
function ytDuration(url) {
  return new Promise((res, rej) => {
    const p = spawn('yt-dlp', ['--no-playlist', '--print', 'duration', url])
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', rej)
    p.on('close', (c) => (c === 0 ? res(parseFloat(out) || 0) : rej(new Error('yt-dlp duration failed'))))
  })
}

// Auto-subtitle text for better moment picks. Non-fatal — '' if none.
function ytTranscript(url, dir) {
  return new Promise((res) => {
    const base = path.join(dir, 'sub')
    const p = spawn('yt-dlp', ['--no-playlist', '--skip-download', '--write-auto-subs',
      '--sub-lang', 'en', '--sub-format', 'vtt', '-o', base, url])
    p.on('error', () => res(''))
    p.on('close', () => {
      try {
        const f = fs.readdirSync(dir).find((n) => n.startsWith('sub') && n.endsWith('.vtt'))
        if (!f) return res('')
        const text = fs.readFileSync(path.join(dir, f), 'utf8')
          .split('\n')
          .filter((l) => l && l !== 'WEBVTT' && !l.includes('-->') && !/^\d+$/.test(l))
          .join(' ')
          .replace(/<[^>]+>/g, '')
        res(text)
      } catch {
        res('')
      }
    })
  })
}

// Job: { videoUrl, title }. Returns { clips }.
async function renderAutoClips(job, supabase) {
  const { videoUrl, title } = job.script || {}
  if (!videoUrl) throw new Error('videoUrl missing')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-'))
  try {
    // 1. Metadata only — fast.
    const duration = await ytDuration(videoUrl).catch(() => 0)
    const transcript = await ytTranscript(videoUrl, dir).catch(() => '')

    // 2. Qwen picks moments (with score, so no per-clip scoring round trip).
    const { moments } = await qwenJSON(
      'Pick the 5 most viral moments. Return JSON {moments:[{start,end,reason,score}]}. ' +
        'start/end in seconds, each clip 15-60s, within the video length. score is 0-100.',
      `Video "${title || 'untitled'}" is ${Math.round(duration)}s long.` +
        (transcript ? `\nTranscript:\n${transcript.slice(0, 3000)}` : '')
    )
    const list = (Array.isArray(moments) ? moments : [])
      .map((m) => ({
        start: Math.max(0, Math.round(+m.start || 0)),
        end: Math.round(Math.min(duration || +m.end || 0, +m.end || 0)),
        reason: m.reason || '',
        score: Math.round(+m.score || 0),
      }))
      .filter((m) => m.end > m.start)
      .slice(0, 5)
    if (!list.length) throw new Error('Qwen returned no usable moments')

    // 3. Download ONLY the chosen segments in one yt-dlp call. --remux-video mp4
    //    makes the container deterministic so step 4 can find each file.
    //    ponytail: keyframe-accurate cuts (no --force-keyframes-at-cuts re-encode).
    //    Add it back only if users complain clips start a second early.
    const sections = list.flatMap((m) => ['--download-sections', `*${m.start}-${m.end}`])
    await run('yt-dlp', ['-f', 'best[height<=480]', '--no-playlist', ...sections,
      '--remux-video', 'mp4', '-o', path.join(dir, 'seg_%(section_start)s.%(ext)s'), videoUrl],
      { timeout: 120000 })

    // 4. Map produced files (named by section start) back to moments, upload.
    const produced = {}
    for (const n of fs.readdirSync(dir)) {
      const m = n.match(/^seg_([\d.]+)\.mp4$/)
      if (m) produced[Math.round(+m[1])] = path.join(dir, n)
    }
    const clips = []
    for (let i = 0; i < list.length; i++) {
      const m = list[i]
      const file = produced[m.start]
      if (!file) continue // segment failed (geo-block etc.) — skip, keep the rest
      const url = await uploadPublic(supabase, BUCKET, `${job.id}/clip-${i}.mp4`,
        fs.readFileSync(file), 'video/mp4')
      clips.push({
        url, start: m.start, end: m.end, reason: m.reason,
        caption: m.reason, score: m.score, reasons: [m.reason],
      })
    }
    if (!clips.length) throw new Error('No segments downloaded')
    clips.sort((a, b) => b.score - a.score)
    return { clips }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

module.exports = { renderAutoClips }
