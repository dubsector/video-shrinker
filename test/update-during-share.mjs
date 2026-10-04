// Shares a video into the built app while a new version of it is released,
// in desktop Chrome, and checks the share is never silently lost. The app
// updates itself with a quiet reload whenever it has nothing worth keeping,
// and returning to it from a share is exactly when it looks for an update.
//
// The built app in dist/ is served at /video-shrinker/ as on GitHub Pages.
// "Releasing a new version" means serving a service worker with different
// bytes, which is what the browser compares.
//
// Usage: npm run build && node test/update-during-share.mjs
// Needs Chrome or Chromium: set CHROME to its path if it isn't on PATH.
// Drives Chrome over the DevTools protocol directly, like
// android/emulator-test/page.mjs, so it needs no packages.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const DIST = path.resolve(process.argv[2] || 'dist')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- Serving the app ---------------------------------------------------

let version = 1
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
}
const SHARE_FORM = `<form id="form" method="post" enctype="multipart/form-data" action="/video-shrinker/share-target">
<input type="file" name="video" id="file"></form>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  // Stands in for the system share sheet: outside the app's scope, so the
  // app's worker sees the POST as a share, as Chrome sends it.
  if (url.pathname === '/share.html') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(SHARE_FORM)
  }
  if (req.method !== 'GET' || !url.pathname.startsWith('/video-shrinker/')) {
    res.writeHead(404)
    return res.end()
  }
  let rel = url.pathname.slice('/video-shrinker/'.length)
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'
  const file = path.join(DIST, rel)
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404)
    return res.end()
  }
  let body = fs.readFileSync(file)
  if (rel === 'sw.js' && version > 1) body = Buffer.concat([body, Buffer.from(`\n// version ${version}\n`)])
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' })
  res.end(body)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://localhost:${server.address().port}`
const APP = `${BASE}/video-shrinker/`

// --- Test files --------------------------------------------------------

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'update-during-share-'))
const VIDEO = path.join(work, 'shared-clip.mp4')
const NOT_VIDEO = path.join(work, 'notes.txt')
const ffmpeg = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', VIDEO])
if (ffmpeg.status !== 0) throw new Error('ffmpeg could not make the test video; is it installed?')
fs.writeFileSync(NOT_VIDEO, 'not a video')

// --- Chrome over the DevTools protocol ---------------------------------

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name]).stdout?.toString().trim()
    if (found) return found
  }
  throw new Error('no Chrome found; set CHROME to its path')
}

async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(work, 'profile-'))
  const chrome = spawn(findChrome(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise((resolve, reject) => {
    let err = ''
    chrome.stderr.on('data', (chunk) => {
      err += chunk
      const match = err.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) resolve(match[1])
    })
    chrome.on('exit', () => reject(new Error(`Chrome exited: ${err}`)))
  })
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('could not connect to Chrome'))
  })
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    const waiter = pending.get(msg.id)
    if (!waiter) return
    pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`))
    else waiter.resolve(msg.result)
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject, method })
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  return {
    send,
    async newTab() {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
      return new Tab((method, params) => send(method, params, sessionId))
    },
    close() {
      ws.close()
      chrome.kill()
    },
  }
}

class Tab {
  constructor(send) {
    this.send = send
  }

  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description || exceptionDetails.text}`)
    return result.value
  }

  // Evaluating while the page navigates or reloads fails; that just means
  // try again.
  async waitFor(expression, what, timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs
    for (;;) {
      const value = await this.eval(expression).catch(() => undefined)
      if (value) return value
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await sleep(250)
    }
  }

  async go(url) {
    await this.send('Page.navigate', { url })
    await this.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, `${url} to load`)
  }

  async openApp() {
    await this.go(APP)
    await this.waitFor('navigator.serviceWorker.controller !== null', 'the app to be ready offline')
  }

  // Shares a file the way Chrome delivers a share to an installed web app:
  // a form POST to the app's share target.
  async share(file) {
    await this.go(`${BASE}/share.html`)
    const { result } = await this.send('Runtime.evaluate', { expression: 'document.getElementById("file")' })
    await this.send('DOM.setFileInputFiles', { files: [file], objectId: result.objectId })
    await this.eval('document.getElementById("form").submit()')
    await this.waitFor(`location.href.startsWith(${JSON.stringify(APP)})`, 'the app to open with the share')
  }

  text() {
    return this.eval('document.body.innerText').catch(() => '')
  }

  async checkForUpdate() {
    await this.eval('navigator.serviceWorker.getRegistration().then((r) => r.update())')
  }
}

// --- Scenarios ---------------------------------------------------------

const SHARED = /shared-clip\.mp4/
const ERROR = /Try picking the file directly|Please choose a video file/

async function waitForText(tab, pattern, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const text = await tab.text()
    if (pattern.test(text)) return
    if (Date.now() > end) throw new Error(`${what}; the page shows: ${JSON.stringify(text.slice(0, 400))}`)
    await sleep(250)
  }
}

// Gives a reload the app might do by itself time to happen, then checks
// what is on screen.
async function stillShows(tab, pattern, what) {
  await sleep(6_000)
  await waitForText(tab, pattern, what, 5_000)
}

const scenarios = {
  'a new version comes out just before the share': async (browser) => {
    const tab = await browser.newTab()
    await tab.openApp()
    version++
    await tab.share(VIDEO)
    await waitForText(tab, SHARED, 'the shared video never arrived')
    await stillShows(tab, SHARED, 'the shared video was lost after it arrived')
  },
  'the new version is already waiting when the share arrives': async (browser) => {
    const idle = await browser.newTab()
    await idle.openApp()
    version++
    await idle.checkForUpdate()
    const tab = await browser.newTab()
    await tab.share(VIDEO)
    await waitForText(tab, SHARED, 'the shared video never arrived')
    await stillShows(tab, SHARED, 'the shared video was lost after it arrived')
  },
  'the new version is waiting in the same tab when the share replaces it': async (browser) => {
    const tab = await browser.newTab()
    await tab.openApp()
    version++
    await tab.checkForUpdate()
    await tab.share(VIDEO)
    await waitForText(tab, SHARED, 'the shared video never arrived')
    await stillShows(tab, SHARED, 'the shared video was lost after it arrived')
  },
  'a new version comes out after the share, and the user takes it': async (browser) => {
    const tab = await browser.newTab()
    await tab.openApp()
    await tab.share(VIDEO)
    await waitForText(tab, SHARED, 'the shared video never arrived')
    version++
    await tab.checkForUpdate()
    await tab.waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent === 'Reload to update')`,
      'the update prompt (the app should ask, not reload, with a video loaded)')
    await tab.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent === 'Reload to update').click()`)
    await stillShows(tab, SHARED, 'the shared video was gone after updating')
  },
  'a share fails, then a new version comes out': async (browser) => {
    const tab = await browser.newTab()
    await tab.openApp()
    await tab.share(NOT_VIDEO)
    await waitForText(tab, ERROR, 'the failed share showed no error')
    version++
    await tab.checkForUpdate()
    await stillShows(tab, ERROR, 'the update reloaded the app and wiped the error, leaving it empty')
  },
}

let failed = 0
for (const [name, run] of Object.entries(scenarios)) {
  version = 1
  const browser = await launchChrome()
  try {
    await run(browser)
    console.log(`ok - ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL - ${name}: ${err.message}`)
  } finally {
    browser.close()
  }
}
server.close()
fs.rmSync(work, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
