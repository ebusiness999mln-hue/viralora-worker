const { execSync } = require('child_process')
const fs = require('fs')

const CAPTION_STYLES = {
  'tiktok-style': {
    name: '🔥 TikTok Style',
    ffmpeg: 'fontsize=64:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=15:fontweight=900',
    preview: { bg: '#000000', text: '#FFFFFF', border: '3px solid #FF0050' }
  },
  'bold-white': {
    name: '⚡ Bold White',
    ffmpeg: 'fontsize=56:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=10',
    preview: { bg: '#000000', text: '#FFFFFF', border: '3px solid #FFFFFF' }
  },
  'neon-red': {
    name: '🔴 Neon Red',
    ffmpeg: 'fontsize=56:fontcolor=red:shadowcolor=red:shadowx=2:shadowy=2:box=1:boxcolor=black@0.8',
    preview: { bg: '#0a0a0a', text: '#FF0000', border: '3px solid #FF0000', shadow: '0 0 10px red' }
  },
  'yellow-pop': {
    name: '💛 Yellow Pop',
    ffmpeg: 'fontsize=60:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=12',
    preview: { bg: '#111111', text: '#FFE500', border: '3px solid #FFE500' }
  },
  'white-outline': {
    name: '✨ White Outline',
    ffmpeg: 'fontsize=56:fontcolor=white:borderw=4:bordercolor=black',
    preview: { bg: 'transparent', text: '#FFFFFF', border: '3px solid #CCCCCC', textShadow: '-2px -2px 0 #000, 2px -2px 0 #000' }
  },
  'gradient-gold': {
    name: '🏆 Gold Premium',
    ffmpeg: 'fontsize=56:fontcolor=gold:shadowcolor=darkorange:shadowx=3:shadowy=3:box=1:boxcolor=black@0.5',
    preview: { bg: '#1a1000', text: '#FFD700', border: '3px solid #FFD700', shadow: '0 0 15px orange' }
  },
  'minimal-clean': {
    name: '🎯 Minimal',
    ffmpeg: 'fontsize=48:fontcolor=white:box=1:boxcolor=black@0.3:boxborderw=6',
    preview: { bg: 'rgba(0,0,0,0.3)', text: '#FFFFFF', border: '1px solid rgba(255,255,255,0.3)' }
  }
}

function extractVideoId(url) {
  const m = String(url).match(/(?:v=|\/shorts\/|youtu\.be\/|\/embed\/)([\w-]{11})/)
  return m ? m[1] : null
}

async function renderAutoClips(job, supabase) {
  const { videoUrl, captionStyle = 'tiktok-style' } = job.script || {}
  const jobId = job.id
  const tmpDir = `/tmp/${jobId}`
  const videoId = extractVideoId(videoUrl)
  const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

  try {
    fs.mkdirSync(tmpDir, { recursive: true })

    // Write YouTube cookies for yt-dlp. main.py has no --cookies flag (passing
    // one crashes argparse) and yt-dlp's Python API ignores config files, so we
    // hand the cookie path in via env — the Dockerfile patches the cloned
    // downloader's ydl_opts to read YTDLP_COOKIES.
    const cookiePath = '/tmp/yt-cookies.txt'
    if (process.env.COOKIE_BASE64) {
      fs.writeFileSync(cookiePath, Buffer.from(process.env.COOKIE_BASE64, 'base64'))
    }
    const cookieEnv = fs.existsSync(cookiePath) ? { YTDLP_COOKIES: cookiePath } : {}

    // Run AI-Youtube-Shorts-Generator
    const resultFile = `${tmpDir}/result.json`
    execSync(
      `cd /app/shorts-generator && python3 main.py "${videoUrl}" \
        --mode local \
        --num-clips 5 \
        --aspect-ratio 9:16 \
        --format 480 \
        --output-json "${resultFile}"`,
      { timeout: 300000, env: { ...process.env, ...cookieEnv } }
    )

    const data = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    const shorts = data.shorts || data.clips || []

    const style = CAPTION_STYLES[captionStyle] || CAPTION_STYLES['tiktok-style']
    const clips = []

    for (let i = 0; i < shorts.length; i++) {
      const short = shorts[i]
      const rawClip = short.clip_url || short.path
      if (!rawClip || !fs.existsSync(rawClip)) continue

      // Add caption style
      const styledClip = `${tmpDir}/styled_${i}.mp4`
      const caption = (short.hook_sentence || short.hook || short.title || 'Watch this').replace(/['"]/g, '')

      try {
        execSync(
          `ffmpeg -y -i "${rawClip}" \
            -vf "drawtext=fontfile=${FONT}:text='${caption}':${style.ffmpeg}:x=(w-text_w)/2:y=h-150" \
            -c:v libx264 -preset veryfast -c:a aac "${styledClip}"`,
          { timeout: 60000 }
        )
      } catch {
        fs.copyFileSync(rawClip, styledClip)
      }

      // Generate thumbnail
      const thumbPath = `${tmpDir}/thumb_${i}.jpg`
      try {
        execSync(`ffmpeg -y -i "${styledClip}" -ss 1 -vframes 1 "${thumbPath}"`, { timeout: 10000 })
      } catch {}

      // Upload clip
      const clipBuffer = fs.readFileSync(styledClip)
      await supabase.storage.from('viralora-videos').upload(`clips/${jobId}/clip_${i}.mp4`, clipBuffer, { contentType: 'video/mp4', upsert: true })
      const { data: { publicUrl: clipUrl } } = supabase.storage.from('viralora-videos').getPublicUrl(`clips/${jobId}/clip_${i}.mp4`)

      // Upload thumbnail
      let thumbUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
      if (fs.existsSync(thumbPath)) {
        const thumbBuffer = fs.readFileSync(thumbPath)
        await supabase.storage.from('viralora-videos').upload(`clips/${jobId}/thumb_${i}.jpg`, thumbBuffer, { contentType: 'image/jpeg', upsert: true })
        const { data: { publicUrl: tUrl } } = supabase.storage.from('viralora-videos').getPublicUrl(`clips/${jobId}/thumb_${i}.jpg`)
        thumbUrl = tUrl
      }

      clips.push({
        url: clipUrl,
        thumbnail: thumbUrl,
        start: short.start_time || 0,
        duration: short.duration || (short.end_time - short.start_time) || 30,
        score: short.score || 85,
        reason: short.hook_sentence || short.hook || 'Viral moment',
        caption,
        captionStyle
      })
    }

    execSync(`rm -rf ${tmpDir}`)
    if (!clips.length) throw new Error('No clips generated')
    clips.sort((a, b) => b.score - a.score)
    return { clips }

  } catch (error) {
    execSync(`rm -rf ${tmpDir} 2>/dev/null || true`)
    throw error
  }
}

module.exports = { renderAutoClips, extractVideoId, CAPTION_STYLES }
