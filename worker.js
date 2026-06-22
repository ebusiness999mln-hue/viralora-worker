require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const ws = require('ws')
const { renderHyperFrames, buildHtml, normalizeScenes, clampDuration } = require('./lib/hyperframes')
const { renderAutoClips } = require('./lib/autoclips')

let _sb
function sb() {
  // Node has no native WebSocket — give realtime the `ws` impl so it stops erroring.
  if (!_sb) _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    global: { fetch },
    realtime: { transport: ws },
  })
  return _sb
}

// Process one job. Handlers return the column patch to merge on completion:
//   auto-clips -> { result: { clips } }   hyperframes -> { asset_url }
async function handle(job) {
  const kind = job.script && job.script.kind
  if (kind === 'auto-clips') return { result: await renderAutoClips(job, sb()) }
  if (kind === 'hyperframes') return await renderHyperFrames(job, sb())
  throw new Error(`unknown job kind: ${kind}`)
}

// Claim one job by id (status guard prevents double-processing if the poll loop
// and a direct /render trigger race — only the first update wins) and run it.
async function runJob(jobId) {
  const { data: claimed } = await sb()
    .from('render_jobs').update({ status: 'processing' })
    .eq('id', jobId).eq('status', 'pending').select().single()
  if (!claimed) return false // already claimed / not pending
  try {
    const patch = await handle(claimed)
    await sb().from('render_jobs').update({ status: 'completed', ...patch }).eq('id', jobId)
    console.log(`✓ job ${jobId} (${claimed.script?.kind})`)
  } catch (e) {
    console.error(`✗ job ${jobId}:`, e.message)
    await sb().from('render_jobs').update({ status: 'failed', error: e.message }).eq('id', jobId)
  }
  return true
}

async function poll() {
  try {
    console.log('polling...')
    const { data: rows, error } = await sb()
      .from('render_jobs')
      .select('id, script')
      .eq('status', 'pending')
      .limit(1)

    console.log('poll result:', { rows: rows?.length, error: error?.message })

    if (error) {
      console.error('poll query error:', error.message)
    } else if (rows && rows[0]) {
      console.log('found job:', rows[0].id)
      await runJob(rows[0].id)
    } else {
      console.log('no pending jobs')
    }
  } catch (e) {
    console.error('poll error:', e.message)
  }
  setTimeout(poll, 5000)
}

module.exports = { runJob }

// ── self-check: node worker.js --selftest ──
if (process.argv.includes('--selftest')) {
  const a = require('assert')
  a.strictEqual(clampDuration(999), 60)
  a.strictEqual(clampDuration('abc'), 15)
  const even = normalizeScenes([{ text: 'a' }, { text: 'b' }], 10)
  a.strictEqual(even.length, 2)
  a.strictEqual(even[1].end, 10)
  const timed = normalizeScenes([{ text: 'x', startTime: 0, endTime: 3 }], 30)
  a.strictEqual(timed[0].end, 3)
  a.ok(buildHtml(even, {}).includes('frameAt'))
  console.log('selftest ok')
  process.exit(0)
}

console.log('viralora-worker polling render_jobs…')
poll()
