require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function processJob(job) {
  const projectDir = path.join(__dirname, 'renders', job.id)

  // Create project from template
  execSync(`npx hyperframes init ${projectDir} --template kinetic-type --yes`)

  // Generate custom HTML with job script
  const html = generateHTML(job.script, job.style)
  fs.writeFileSync(path.join(projectDir, 'index.html'), html)

  // Render to MP4
  execSync(`npx hyperframes render --output ${projectDir}/output.mp4`, {
    cwd: projectDir
  })

  // Upload to Supabase Storage
  const videoBuffer = fs.readFileSync(`${projectDir}/output.mp4`)
  const fileName = `videos/${job.user_id}/${job.id}.mp4`

  await supabase.storage
    .from('viralora-videos')
    .upload(fileName, videoBuffer, { contentType: 'video/mp4' })

  const { data: { publicUrl } } = supabase.storage
    .from('viralora-videos')
    .getPublicUrl(fileName)

  // Update job status
  await supabase
    .from('render_jobs')
    .update({ status: 'completed', asset_url: publicUrl })
    .eq('id', job.id)

  console.log('Rendered:', publicUrl)
}

function generateHTML(script, style) {
  return `<!DOCTYPE html>
<html>
<head>
<style>
body {
  width: 1080px;
  height: 1920px;
  background: ${style?.background || '#05050A'};
  font-family: ${style?.font || 'Inter, sans-serif'};
  overflow: hidden;
  margin: 0;
}
.text {
  color: ${style?.textColor || '#FFFFFF'};
  font-size: ${style?.fontSize || '80px'};
  font-weight: 900;
  text-align: center;
  position: absolute;
  width: 100%;
  -webkit-text-stroke: 3px ${style?.outlineColor || '#000000'};
  text-shadow: 0 0 30px ${style?.glowColor || '#FF3D57'};
}
</style>
</head>
<body>
<div id="stage" data-composition-id="viral-video" data-start="0" data-width="1080" data-height="1920">
  ${script.scenes.map((scene, i) => `
  <div class="text clip"
    data-start="${scene.startTime}"
    data-duration="${scene.duration}"
    data-track-index="1"
    style="top: 50%; transform: translateY(-50%)">
    ${scene.text}
  </div>`).join('')}
</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script>
const tl = gsap.timeline({ paused: true })
${script.scenes.map((scene, i) => `
tl.from('.clip:nth-child(${i+1})', {
  scale: 0,
  rotation: -10,
  opacity: 0,
  duration: 0.3,
  ease: 'elastic.out(1, 0.3)'
}, ${scene.startTime})
`).join('')}
window.__timelines = window.__timelines || {}
window.__timelines['viral-video'] = tl
</script>
</body>
</html>`
}

async function poll() {
  const { data: jobs } = await supabase
    .from('render_jobs')
    .select('*')
    .eq('status', 'pending')
    .limit(1)

  if (jobs && jobs.length > 0) {
    const job = jobs[0]
    await supabase.from('render_jobs').update({ status: 'processing' }).eq('id', job.id)
    try {
      await processJob(job)
    } catch (error) {
      await supabase.from('render_jobs').update({ status: 'failed', error: error.message }).eq('id', job.id)
      console.error('Job failed:', error)
    }
  }

  setTimeout(poll, 5000)
}

console.log('Viralora render worker started...')
poll()
