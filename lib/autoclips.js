const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const CAPTION_STYLES = {
  'bold-white': 'fontsize=56:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=10',
  'neon-red': 'fontsize=56:fontcolor=red:shadowcolor=red:shadowx=2:shadowy=2:box=1:boxcolor=black@0.8:boxborderw=8',
  'yellow-pop': 'fontsize=60:fontcolor=yellow:fontweight=900:box=1:boxcolor=black@0.7:boxborderw=12',
  'white-outline': 'fontsize=56:fontcolor=white:borderw=4:bordercolor=black',
  'tiktok-style': 'fontsize=64:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=15:fontweight=900',
  'gradient-gold': 'fontsize=56:fontcolor=gold:shadowcolor=darkorange:shadowx=3:shadowy=3:box=1:boxcolor=black@0.5',
  'minimal-clean': 'fontsize=48:fontcolor=white:alpha=0.9:box=1:boxcolor=black@0.3:boxborderw=6'
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

  try {
    fs.mkdirSync(tmpDir, { recursive: true })

    // Step 1: Run AI-Youtube-Shorts-Generator. Only the real CLI flags exist
    // (url, --mode, --num-clips, --aspect-ratio, --format, --output-json PATH);
    // --output-json writes the result JSON to a file, stdout is human-readable.
    const resultJson = `${tmpDir}/result.json`
    execSync(
      `cd /app/shorts-generator && python3 main.py "${videoUrl}" \
        --mode local \
        --num-clips 5 \
        --aspect-ratio 9:16 \
        --format 480 \
        --output-json "${resultJson}"`,
      { timeout: 300000, env: { ...process.env } }
    )

    const data = JSON.parse(fs.readFileSync(resultJson, 'utf8'))
    const shorts = data.shorts || data.clips || []

    const captionFilter = CAPTION_STYLES[captionStyle] || CAPTION_STYLES['tiktok-style']
    const clips = []

    for (let i = 0; i < shorts.length; i++) {
      const short = shorts[i]
      const rawClip = short.clip_url || short.path || `${tmpDir}/clip_${i}.mp4`
      if (!fs.existsSync(rawClip)) continue

      // Step 2: Apply caption style with FFmpeg
      const styledClip = `${tmpDir}/styled_${i}.mp4`
      const caption = (short.hook_sentence || short.hook || short.title || 'Watch this clip').replace(/'/g, '')

      try {
        execSync(`ffmpeg -y -i "${rawClip}" \
          -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:\
text='${caption}':${captionFilter}:\
x=(w-text_w)/2:y=h-150" \
          -c:v libx264 -preset veryfast -c:a aac "${styledClip}"`,
          { timeout: 60000 }
        )
      } catch {
        fs.copyFileSync(rawClip, styledClip)
      }

      // Step 3: Generate thumbnail at midpoint
      const thumbPath = `${tmpDir}/thumb_${i}.jpg`
      try {
        execSync(`ffmpeg -y -i "${styledClip}" -ss 1 -vframes 1 "${thumbPath}"`, { timeout: 10000 })
      } catch {}

      // Step 4: Upload clip to Supabase
      const clipBuffer = fs.readFileSync(styledClip)
      const clipFile = `clips/${jobId}/clip_${i}.mp4`
      await supabase.storage.from('viralora-videos').upload(clipFile, clipBuffer, { contentType: 'video/mp4', upsert: true })
      const { data: { publicUrl: clipUrl } } = supabase.storage.from('viralora-videos').getPublicUrl(clipFile)

      // Step 5: Upload thumbnail
      let thumbUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`
      if (fs.existsSync(thumbPath)) {
        const thumbBuffer = fs.readFileSync(thumbPath)
        const thumbFile = `clips/${jobId}/thumb_${i}.jpg`
        await supabase.storage.from('viralora-videos').upload(thumbFile, thumbBuffer, { contentType: 'image/jpeg', upsert: true })
        const { data: { publicUrl: tUrl } } = supabase.storage.from('viralora-videos').getPublicUrl(thumbFile)
        thumbUrl = tUrl
      }

      clips.push({
        url: clipUrl,
        thumbnail: thumbUrl,
        start: short.start_time || 0,
        duration: short.duration || (short.end_time - short.start_time) || 30,
        score: short.score || 85,
        reason: short.hook_sentence || short.hook || 'Viral moment',
        caption: caption,
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
