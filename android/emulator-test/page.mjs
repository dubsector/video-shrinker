// Drives the web app inside the emulator's Chrome over the DevTools protocol.
// smoke-test.sh forwards Chrome's DevTools socket to localhost:9222 first.
//
// Usage: node page.mjs <loaded | shared NAME | convert | progress | finished>
// Prints what it saw and exits non-zero if the check fails.

const DEVTOOLS = 'http://127.0.0.1:9222'
const APP_URL = 'https://dubsector.github.io/video-shrinker/'
const TARGET_MB = 2

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function findPage(timeoutMs) {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      const targets = await (await fetch(`${DEVTOOLS}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith(APP_URL))
      if (page) return page
    } catch {
      // Chrome may still be starting.
    }
    if (Date.now() > end) throw new Error(`no Chrome tab showing ${APP_URL}`)
    await sleep(2000)
  }
}

async function connect() {
  const page = await findPage(60_000)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('could not open the DevTools connection'))
  })
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    pending.get(msg.id)?.(msg)
    pending.delete(msg.id)
  }

  // Evaluates an expression in the page and returns its value. Gives up after
  // timeoutMs, since a frozen background page never answers.
  async function evaluate(expression, timeoutMs = 15_000) {
    const id = nextId++
    const reply = new Promise((resolve) => pending.set(id, resolve))
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }))
    const msg = await Promise.race([
      reply,
      sleep(timeoutMs).then(() => { throw new Error('the page did not respond') }),
    ])
    if (msg.error) throw new Error(msg.error.message)
    if (msg.result.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'page exception')
    return msg.result.result.value
  }

  // Polls a page expression until it returns something truthy.
  async function waitFor(expression, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    for (;;) {
      const value = await evaluate(expression).catch(() => null)
      if (value) return value
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await sleep(2000)
    }
  }

  return { page, evaluate, waitFor, close: () => ws.close() }
}

const STATE = `(() => ({
  url: location.href,
  visibility: document.visibilityState,
  file: document.querySelector('.file-info strong')?.textContent ?? null,
  button: document.querySelector('.convert-button')?.textContent ?? null,
  progress: document.querySelector('.progress-label')?.textContent ?? null,
  result: document.querySelector('.result')?.textContent ?? null,
  error: document.querySelector('.message.error')?.textContent ?? null,
}))()`

async function main() {
  const [command, arg] = process.argv.slice(2)
  const app = await connect()
  const log = (label, value) => console.log(`[page] ${label}: ${JSON.stringify(value)}`)
  try {
    switch (command) {
      case 'loaded': {
        await app.waitFor(`document.readyState === 'complete' && !!document.querySelector('.convert-button')`, 90_000, 'the app to render')
        // The share target is handled by the service worker, so a share sent
        // before it controls the page would be lost.
        await app.waitFor(`!!navigator.serviceWorker.controller`, 90_000, 'the service worker to take control')
        log('loaded', await app.evaluate(STATE))
        break
      }
      case 'shared': {
        const state = await app.waitFor(
          `(() => { const s = ${STATE}; return (s.file === ${JSON.stringify(arg)} || s.error) ? s : null })()`,
          120_000, 'the shared video to show up')
        log('shared', state)
        if (state.error) throw new Error(`the app showed an error: ${state.error}`)
        break
      }
      case 'convert': {
        // Aim well below the test video's size so it really re-encodes.
        await app.evaluate(`(() => {
          [...document.querySelectorAll('.preset')].find((b) => b.textContent.trim() === '10 MB').click()
          const decrease = document.querySelector('.step-button')
          for (let mb = 10; mb > ${TARGET_MB}; mb--) decrease.click()
          return true
        })()`)
        await sleep(500)
        await app.evaluate(`document.querySelector('.convert-button').click(), true`)
        const state = await app.waitFor(
          `(() => { const s = ${STATE}; return (s.progress || s.result || s.error) ? s : null })()`,
          60_000, 'the conversion to start')
        log('converting', state)
        if (state.error) throw new Error(`the app showed an error: ${state.error}`)
        break
      }
      case 'progress': {
        log('progress', await app.evaluate(STATE))
        break
      }
      case 'finished': {
        const state = await app.waitFor(
          `(() => { const s = ${STATE}; return (s.result || s.error) ? s : null })()`,
          15 * 60_000, 'the conversion to finish')
        log('finished', state)
        if (state.error) throw new Error(`the app showed an error: ${state.error}`)
        break
      }
      default:
        throw new Error(`unknown command ${command}`)
    }
  } finally {
    app.close()
  }
}

main().catch((err) => {
  console.error(`[page] ${err.message}`)
  process.exit(1)
})
