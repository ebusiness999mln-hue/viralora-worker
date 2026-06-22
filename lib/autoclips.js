// Auto Clips handler — REAL clip cutting.
// Qwen picks viral moments, yt-dlp downloads just those sections, FFmpeg burns a
// caption, we upload the MP4 to Supabase Storage and return real video URLs.
// Any per-clip failure (or no yt-dlp) falls back to a YouTube deep-link so the
// user always gets something back.
// Returns { clips: [{ url, thumbnail, start, duration, score, reason }] }.

const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs/promises')
const run = promisify(execFile)
const { uploadPublic } = require('./storage')

const MODEL = 'openrouter/free'
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

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

// Pull the 11-char video id from any common YouTube URL shape.
function videoId(url) {
  const m = String(url).match(/(?:v=|\/shorts\/|youtu\.be\/|\/embed\/)([\w-]{11})/)
  return m ? m[1] : null
}

// ponytail: strip to plain text so it's safe inside FFmpeg drawtext text='...'
// (no quotes/colons/backslashes left to escape). Upgrade to textfile= if we ever
// need punctuation or emoji in captions.
function safeCaption(s) {
  return String(s || '').replace(/[^a-zA-Z0-9 ?!.,]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Clip'
}

// Job: { id, script:{ videoUrl, title } }. Returns { clips }.
async function renderAutoClips(job, supabase) {
  const jobId = job.id
  const { videoUrl, title } = job.script || {}
  const id = videoId(videoUrl)
  if (!id) throw new Error('could not parse YouTube video id from videoUrl')

  const { moments } = await qwenJSON(
    'Pick the 5 most viral moments of a YouTube video. Return JSON ' +
      '{moments:[{start,end,caption,reason,score}]}. start/end are offsets in seconds ' +
      '(0-3600, end 10-60s after start). caption: a short punchy on-screen line. ' +
      'score is 0-100. reason: one short sentence on why it would go viral.',
    `Video title: "${title || 'untitled'}". Suggest 5 strong moments.`
  )

  const picks = (Array.isArray(moments) ? moments : []).slice(0, 5).map((m) => {
    const start = Math.max(0, Math.round(+m.start || 0))
    let end = Math.round(+m.end || 0)
    if (!(end > start)) end = start + 30
    end = Math.min(end, start + 60) // cap clip length
    return {
      start,
      end,
      caption: safeCaption(m.caption || m.reason),
      score: Math.round(+m.score || 0),
      reason: m.reason || '',
    }
  })
  if (!picks.length) throw new Error('Qwen returned no usable moments')

  const tmp = `/tmp/${jobId}`
  await fs.mkdir(tmp, { recursive: true }).catch(() => {})

  const tsLink = (start) => `https://www.youtube.com/watch?v=${id}&t=${start}s`
  const thumb = `https://img.youtube.com/vi/${id}/maxresdefault.jpg`

  const clips = []
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i]
    const base = { thumbnail: thumb, start: p.start, duration: p.end - p.start, score: p.score, reason: p.reason }
    const raw = `${tmp}/clip_${i}.mp4`
    const out = `${tmp}/out_${i}.mp4`
    try {
      await run('yt-dlp', [
        '--download-sections', `*${p.start}-${p.end}`,
        '-f', 'best[height<=480]',
        '-o', raw,
        videoUrl,
      ], { timeout: 120000 })

      let upload = raw
      try {
        await run('ffmpeg', [
          '-y', '-i', raw,
          '-vf', `drawtext=fontfile=${FONT}:text='${p.caption}':fontsize=40:fontcolor=white:x=(w-text_w)/2:y=h-100:box=1:boxcolor=black@0.5`,
          '-c:a', 'copy', out,
        ], { timeout: 120000 })
        upload = out
      } catch (e) {
        console.error(`clip ${i} caption failed, uploading raw:`, e.message) // ponytail: ship uncaptioned over nothing
      }

      const buf = await fs.readFile(upload)
      const url = await uploadPublic(supabase, 'autoclips', `${jobId}/clip_${i}.mp4`, buf, 'video/mp4')
      clips.push({ url, ...base })
    } catch (e) {
      console.error(`clip ${i} failed, falling back to timestamp:`, e.message)
      clips.push({ url: tsLink(p.start), ...base }) // always return something
    }
  }

  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})

  clips.sort((a, b) => b.score - a.score)
  return { clips }
}

module.exports = { renderAutoClips, videoId, safeCaption }

// ── self-check: node lib/autoclips.js --selftest ──
if (require.main === module && process.argv.includes('--selftest')) {
  const a = require('assert')
  a.strictEqual(videoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  a.strictEqual(videoId('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ')
  a.strictEqual(videoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  a.strictEqual(videoId('not a url'), null)
  a.strictEqual(safeCaption("It's a 100%: win!"), 'It s a 100 win!')
  a.strictEqual(safeCaption(''), 'Clip')
  console.log('autoclips selftest ok')
}
