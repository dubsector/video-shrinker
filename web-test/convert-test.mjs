// Converts a video with the built web app (dist/) in desktop Chrome and
// checks what comes out: the app reports a result, and the download is a
// video that plays through, runs as long as the original and fits the size
// asked for.
//
// Usage: node web-test/convert-test.mjs
// Run from the repository root after `npm run build`. Needs ffmpeg and
// ffprobe on PATH, playwright-core, and Google Chrome (or CHROME_PATH set to
// another Chromium). Screenshots and the converted video go to $OUT_DIR
// (default: web-test-output).

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const OUT_DIR = process.env.OUT_DIR ?? 'web-test-output'
const PORT = 4173
const APP_URL = `http://localhost:${PORT}/video-shrinker/`
const TARGET_MB = 2
const SECONDS = 12

mkdirSync(OUT_DIR, { recursive: true })

// The emulator tests' noisy 720p clip, which can't reach the target without
// really being re-encoded, with a tone added so the sound is covered too.
const source = join(OUT_DIR, 'source.mp4')
execFileSync('ffmpeg', [
  '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${SECONDS}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`,
  '-vf', 'noise=alls=25:allf=t',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', '8M', '-maxrate', '8M', '-bufsize', '8M',
  '-c:a', 'aac', '-b:a', '128k',
  source,
])
const sourceBytes = statSync(source).size
console.log(`Test video: ${sourceBytes} bytes`)

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file])
  const { format, streams } = JSON.parse(out)
  return {
    seconds: Number(format.duration),
    video: streams.find((s) => s.codec_type === 'video'),
    audio: streams.find((s) => s.codec_type === 'audio'),
  }
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
async function serverUp() {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) break
    if (await fetch(APP_URL).then((r) => r.ok, () => false)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`the built app never came up on ${APP_URL}; was it built?`)
}

let browser
let failed = false
try {
  await serverUp()
  browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
  )
  console.log(`Chrome ${browser.version()}`)
  const page = await browser.newPage()
  const say = (kind, text) => console.log(`[page] ${kind}: ${text}`)
  page.on('console', (msg) => say(msg.type(), msg.text()))
  page.on('pageerror', (err) => say('exception', err.message))
  page.on('worker', (worker) => worker.on('console', (msg) => say(`worker ${msg.type()}`, msg.text())))

  await page.goto(APP_URL)
  await page.locator('.convert-button').waitFor()
  await page.locator('input[type=file]').setInputFiles(source)
  await page.locator('.file-info strong', { hasText: 'source.mp4' }).waitFor()

  // The size field starts from the 10 MB preset; step down from there.
  await page.locator('.preset', { hasText: /^\s*10 MB\s*$/ }).click()
  for (let mb = 10; mb > TARGET_MB; mb--) await page.locator('.step-button').first().click()
  await page.locator('.convert-button').click()

  // ffmpeg.wasm, where Chrome can't encode H.264 itself, takes a few minutes.
  const outcome = page.locator('.result, .message.error')
  await outcome.first().waitFor({ timeout: 8 * 60_000 })
  await page.screenshot({ path: join(OUT_DIR, 'done.png'), fullPage: true })
  const error = page.locator('.message.error')
  if (await error.count()) throw new Error(`the app showed an error: ${await error.first().innerText()}`)
  console.log(`Result: ${(await page.locator('.result p').innerText()).replace(/\s+/g, ' ')}`)

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.download-button').click()])
  const output = join(OUT_DIR, 'converted.mp4')
  await download.saveAs(output)
  console.log(`Downloaded as ${download.suggestedFilename()}`)

  const bytes = statSync(output).size
  const before = probe(source)
  const after = probe(output)
  console.log(`Converted: ${bytes} bytes, ${after.seconds.toFixed(2)} s, ` +
    `${after.video?.codec_name} ${after.video?.width}x${after.video?.height}, audio ${after.audio?.codec_name ?? 'none'}`)

  const problems = []
  if (bytes > TARGET_MB * 1_000_000) problems.push(`it is over ${TARGET_MB} MB`)
  // A file this small would mean most of the video is missing.
  if (bytes < TARGET_MB * 1_000_000 * 0.5) problems.push(`it is under half of the ${TARGET_MB} MB asked for`)
  if (!after.video) problems.push('it has no video')
  // Chrome on Linux has no AAC encoder, and the app leaves the sound out
  // there when it can't copy it across untouched. Shown, but not failed on,
  // until the app does something else about it.
  if (!after.audio) console.log('WARNING: the converted video has no sound')
  if (Math.abs(after.seconds - before.seconds) > 0.5) problems.push(`it runs ${after.seconds} s, not ${before.seconds} s`)
  // Decodes every frame: a file that only looks right in its headers fails here.
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], { stdio: 'pipe' })
  } catch (err) {
    problems.push(`it does not play through: ${String(err.stderr).trim().split('\n')[0]}`)
  }
  if (problems.length) throw new Error(`the converted video is wrong: ${problems.join('; ')}`)
  console.log('PASS')
} catch (err) {
  failed = true
  console.error(`FAIL: ${err.message}`)
} finally {
  await browser?.close()
  server.kill()
}
process.exit(failed ? 1 : 0)
