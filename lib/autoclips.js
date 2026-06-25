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

// COOKIE_BASE64 (a base64'd Netscape cookies.txt) lets yt-dlp authenticate past
// YouTube's datacenter-IP gating. Decode it to /tmp/cookies.txt once and hand
// yt-dlp --cookies. No env -> no flag, so uncookied videos still work.
let cookiePromise
async function cookieArgs() {
  if (!process.env.COOKIE_BASE64) return []
  cookiePromise ??= fs.writeFile('/tmp/cookies.txt', Buffer.from(process.env.COOKIE_BASE64, 'base64'))
  await cookiePromise
  return ['--cookies', '/tmp/cookies.txt']
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

// Cut [start,end] from source into `out`, burning one of the given -vf filters.
// Tries each filter in order (vertical 9:16 first, plain second) and returns the
// first that produces a real video stream. crop math is fragile across odd source
// dims, so a failing crop must NOT cost the whole clip — fall through to plain.
// Throws only if every filter fails. -ss before -i = fast seek; re-encode for a
// frame-accurate cut.
async function cutClip(source, w, out, filters) {
  let lastErr
  for (const vf of filters) {
    try {
      await run('ffmpeg', [
        '-y', '-ss', String(w.start), '-i', source, '-t', String(w.end - w.start),
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart',
        out,
      ], { timeout: 120000 })
      if (await hasVideo(out)) return
      lastErr = new Error('cut produced no video stream')
    } catch (e) {
      lastErr = e
      console.error('ffmpeg filter failed, trying next:', String(e.stderr || e.message || e).slice(-300))
    }
  }
  throw lastErr || new Error('all ffmpeg filters failed')
}

// True iff the file has at least one decodable video stream — catches the
// broken audio-only fragments a failed download/cut can leave behind.
async function hasVideo(file) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0', file,
    ])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

// Video duration in seconds (0 if unknown).
async function probeDuration(file) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ])
    return Math.floor(+stdout.trim() || 0)
  } catch {
    return 0
  }
}

// Fit a [start,end] pick inside a video of length `dur`. The LLM picks blind to
// the real length (told 0-3600s), so picks can land past the end → empty cuts.
// Keep in-range picks exact; for out-of-range ones, spread by index so we still
// get 5 distinct real clips instead of duplicates at the tail.
function fitWindow(p, i, n, dur) {
  if (!dur) return { start: p.start, end: p.end } // unknown length: trust the LLM
  const len = Math.min(p.end - p.start, Math.max(5, dur - 1))
  let start = p.start
  if (start + len > dur) start = Math.floor(((i + 0.5) / n) * Math.max(1, dur - len))
  start = Math.max(0, Math.min(start, dur - len))
  return { start, end: Math.min(dur, start + len) }
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

  // Download the progressive video ONCE, then cut every section locally. Ranged
  // section-downloads (--download-sections) fail on Railway's datacenter IP —
  // YouTube SABR-gates the byte ranges and yt-dlp exits 0 with a broken
  // audio-only file. A single full fetch isn't ranged, so it survives; local
  // ffmpeg cuts are then 100% reliable. tv/web_safari clients dodge SABR.
  const source = `${tmp}/source.mp4`
  let sourceOk = false
  try {
    await run('yt-dlp', [
      '--extractor-args', 'youtube:player_client=mweb,tv,web_safari,ios,android,web',
      ...(await cookieArgs()),
      '-f', 'best[height<=480]/best',
      '--merge-output-format', 'mp4',
      '-o', source,
      videoUrl,
    ], { timeout: 180000 })
    sourceOk = await hasVideo(source)
    if (!sourceOk) console.error('source downloaded but has no video stream')
  } catch (e) {
    console.error('source download failed:', String(e.stderr || e.message || e).slice(-500))
  }

  const dur = sourceOk ? await probeDuration(source) : 0

  for (let i = 0; i < picks.length; i++) {
    const p = picks[i]
    const w = fitWindow(p, i, picks.length, dur) // keep picks inside the real video length
    const base = {
      youtubeUrl: tsLink(w.start),
      thumbnail: thumb,
      start: w.start,
      end: w.end,
      score: p.score,
      reason: p.reason,
      caption: p.caption,
    }
    const out = `${tmp}/out_${i}.mp4`
    try {
      if (!sourceOk) throw new Error('source video unavailable')
      // Prefer a vertical 9:16 1080x1920 cut for TikTok/Reels/Shorts; if the crop
      // fails on this source's dims, fall back to the original framing (caption
      // only) rather than dropping the clip to a timestamp. crop takes the center
      // vertical slice: crop=ih*9/16:ih:(iw-ih*9/16)/2:0.
      // Force even crop dims (floor(.../2)*2) so libx264 never chokes on an odd
      // width/height; ow/oh are the resolved crop output, centered via (iw-ow)/2.
      const vertical = `crop=floor(ih*9/16/2)*2:floor(ih/2)*2:(iw-ow)/2:(ih-oh)/2,scale=1080:1920,drawtext=fontfile=${FONT}:text='${p.caption}':fontsize=56:fontcolor=white:x=(w-text_w)/2:y=h-320:box=1:boxcolor=black@0.5`
      const plain = `drawtext=fontfile=${FONT}:text='${p.caption}':fontsize=40:fontcolor=white:x=(w-text_w)/2:y=h-100:box=1:boxcolor=black@0.5`
      await cutClip(source, w, out, [vertical, plain])

      const buf = await fs.readFile(out)
      const url = await uploadPublic(supabase, 'autoclips', `${jobId}/clip_${i}.mp4`, buf, 'video/mp4')
      clips.push({ url, ...base })
    } catch (e) {
      console.error(`clip ${i} failed, falling back to timestamp:`, String(e.stderr || e.message || e).slice(-400))
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
  // fitWindow: in-range pick is untouched; out-of-range is pulled inside dur.
  const inr = fitWindow({ start: 30, end: 50 }, 0, 5, 213)
  a.deepStrictEqual(inr, { start: 30, end: 50 })
  const oor = fitWindow({ start: 2700, end: 2730 }, 4, 5, 213)
  a.ok(oor.start >= 0 && oor.end <= 213 && oor.end > oor.start, 'oor fit inside dur')
  a.strictEqual(fitWindow({ start: 99, end: 120 }, 0, 5, 0).start, 99) // unknown dur: trust LLM
  console.log('autoclips selftest ok')
}
