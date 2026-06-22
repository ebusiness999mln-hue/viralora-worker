// Auto Clips handler — lightweight real MP4 cuts.
// Moments are picked upstream (Vercel route, via Groq) and arrive in
// job.script.moments. For each we yt-dlp just that section, burn a caption with
// FFmpeg, and upload the MP4 to Supabase Storage. Any per-clip failure (or no
// yt-dlp) falls back to a YouTube deep-link so the user always gets something.
// No Python, no face-tracking ML — ffmpeg + yt-dlp only (already in Dockerfile).
// Returns { clips: [{ url, youtubeUrl, thumbnail, start, end, score, reason, caption }] }.

const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs/promises')
const run = promisify(execFile)
const { uploadPublic } = require('./storage')

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

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

// Normalize an upstream moment into {start,end,caption,score,reason}.
function normalizeMoment(m) {
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
}

// Job: { id, script:{ videoUrl, title, moments } }. Returns { clips }.
async function renderAutoClips(job, supabase) {
  const jobId = job.id
  const { videoUrl, moments } = job.script || {}
  const id = videoId(videoUrl)
  if (!id) throw new Error('could not parse YouTube video id from videoUrl')

  const picks = (Array.isArray(moments) ? moments : []).slice(0, 5).map(normalizeMoment)
  if (!picks.length) throw new Error('no moments supplied in job.script.moments')

  const tmp = `/tmp/${jobId}`
  await fs.mkdir(tmp, { recursive: true }).catch(() => {})

  const tsLink = (start) => `https://www.youtube.com/watch?v=${id}&t=${start}s`
  const thumb = `https://img.youtube.com/vi/${id}/maxresdefault.jpg`

  const clips = []
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i]
    const base = {
      youtubeUrl: tsLink(p.start),
      thumbnail: thumb,
      start: p.start,
      end: p.end,
      score: p.score,
      reason: p.reason,
      caption: p.caption,
    }
    const raw = `${tmp}/clip_${i}.mp4`
    const out = `${tmp}/out_${i}.mp4`
    try {
      await run('yt-dlp', [
        '--download-sections', `*${p.start}-${p.end}`,
        '--force-keyframes-at-cuts',
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

module.exports = { renderAutoClips, videoId, safeCaption, normalizeMoment }

// ── self-check: node lib/autoclips.js --selftest ──
if (require.main === module && process.argv.includes('--selftest')) {
  const a = require('assert')
  a.strictEqual(videoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  a.strictEqual(videoId('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ')
  a.strictEqual(videoId('not a url'), null)
  a.strictEqual(safeCaption("It's a 100%: win!"), 'It s a 100 win!')
  a.strictEqual(safeCaption(''), 'Clip')
  const n = normalizeMoment({ start: 10, end: 5, score: '88.6', caption: 'hi!' })
  a.strictEqual(n.start, 10)
  a.strictEqual(n.end, 40) // end<=start -> start+30
  a.strictEqual(n.score, 89)
  const capped = normalizeMoment({ start: 0, end: 999 })
  a.strictEqual(capped.end, 60) // capped to start+60
  console.log('autoclips selftest ok')
}
