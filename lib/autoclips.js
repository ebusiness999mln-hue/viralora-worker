// Auto Clips handler — viral-moment finder (no video download).
// An LLM (Qwen via OpenRouter free) picks the 5 most viral moments of a YouTube
// video and returns each as a deep-link + thumbnail + score + reason. No yt-dlp,
// no FFmpeg, no Storage upload — pure JSON, so it runs anywhere (free tier safe).
// Returns { clips: [{ youtubeUrl, thumbnail, start, end, score, reason, caption }] }.

const MODEL = 'openrouter/free'

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

// Job: { id, script:{ videoUrl, title } }. Returns { clips }.
async function renderAutoClips(job) {
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

  const thumb = `https://img.youtube.com/vi/${id}/maxresdefault.jpg`

  const clips = (Array.isArray(moments) ? moments : []).slice(0, 5).map((m) => {
    const start = Math.max(0, Math.round(+m.start || 0))
    let end = Math.round(+m.end || 0)
    if (!(end > start)) end = start + 30
    end = Math.min(end, start + 60) // cap clip length
    return {
      youtubeUrl: `https://www.youtube.com/watch?v=${id}&t=${start}s`,
      thumbnail: thumb,
      start,
      end,
      score: Math.round(+m.score || 0),
      reason: m.reason || '',
      caption: m.caption || m.reason || '',
    }
  })
  if (!clips.length) throw new Error('Qwen returned no usable moments')

  clips.sort((a, b) => b.score - a.score)
  return { clips }
}

module.exports = { renderAutoClips, videoId }

// ── self-check: node lib/autoclips.js --selftest ──
if (require.main === module && process.argv.includes('--selftest')) {
  const a = require('assert')
  a.strictEqual(videoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  a.strictEqual(videoId('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ')
  a.strictEqual(videoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  a.strictEqual(videoId('not a url'), null)
  console.log('autoclips selftest ok')
}
