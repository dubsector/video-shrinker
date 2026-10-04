// Drives the web app inside the emulator's Chrome over the DevTools protocol.
// smoke-test.sh forwards Chrome's DevTools socket to localhost:9222 first.
//
// Usage: node page.mjs <loaded | shared NAME | convert | progress | finished | console>
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
    // Events carry no id; only answers to our own requests resolve anything.
    const resolve = pending.get(msg.id)
    if (typeof resolve !== 'function') return
    pending.delete(msg.id)
    resolve(msg)
  }
  // The connection only drops when the tab or Chrome itself goes away, and
  // nothing sent afterwards is ever answered, so fail straight away.
  let closed = false
  ws.onclose = () => {
    closed = true
    for (const resolve of pending.values()) resolve({ error: { message: CLOSED } })
    pending.clear()
  }

  // Evaluates an expression in the page and returns its value. Gives up after
  // timeoutMs, since a frozen background page never answers.
  async function evaluate(expression, timeoutMs = 15_000) {
    if (closed) throw new Error(CLOSED)
    const id = nextId++
    const reply = new Promise((resolve) => pending.set(id, resolve))
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }))
    // The timer is cleared once the page answers: left running, it would keep
    // this process alive for the rest of timeoutMs after the work is done.
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the page did not respond')), timeoutMs)
    })
    const msg = await Promise.race([reply, timeout]).finally(() => clearTimeout(timer))
    if (msg.error) throw new Error(msg.error.message)
    if (msg.result.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'page exception')
    return msg.result.result.value
  }

  // Polls a page expression until it returns something truthy.
  async function waitFor(expression, timeoutMs, what) {
    const end = Date.now() + timeoutMs
    for (;;) {
      const value = await evaluate(expression).catch(unlessClosed)
      if (value) return value
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await sleep(2000)
    }
  }

  // For polling: a page that didn't answer this time may next time, unless
  // the connection is gone.
  function unlessClosed(err) {
    if (closed) throw err
    return null
  }

  return { page, evaluate, waitFor, unlessClosed, close: () => ws.close() }
}

const CLOSED = 'lost the DevTools connection: the tab closed or Chrome quit'

// Set on the page when the conversion starts. If it is gone later, the page
// was reloaded (or Chrome was killed) and the conversion with it.
const MARKER = '__smokeTestConverting'

// JSON.stringify leaves characters that can still end or break out of the
// surrounding page source, so escape those too before embedding a value.
const UNSAFE = { '<': '\\u003C', '>': '\\u003E', '\u2028': '\\u2028', '\u2029': '\\u2029' }
const literal = (value) => JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (c) => UNSAFE[c])

const STATE = `(() => ({
  url: location.href,
  build: document.querySelector('.build-info')?.textContent ?? null,
  sameDocument: !!window.${MARKER},
  // How this document came to be, to tell a discard apart from an update reload.
  navigation: performance.getEntriesByType('navigation')[0]?.type ?? null,
  wasDiscarded: document.wasDiscarded ?? null,
  events: JSON.parse(sessionStorage.getItem('${MARKER}Events') ?? '[]'),
  visibility: document.visibilityState,
  file: document.querySelector('.file-info strong')?.textContent ?? null,
  button: document.querySelector('.convert-button')?.textContent ?? null,
  progress: document.querySelector('.progress-label')?.textContent ?? null,
  result: document.querySelector('.result')?.textContent ?? null,
  error: document.querySelector('.message.error')?.textContent ?? null,
}))()`

// What the app has to work with here: without WebCodecs H.264 or HEVC it
// converts with the much slower ffmpeg.wasm fallback.
const BROWSER = `(async () => {
  const encodes = async (codec) => {
    if (typeof VideoEncoder === 'undefined') return 'no VideoEncoder'
    try {
      const config = { codec, width: 1280, height: 720, bitrate: 4_000_000, framerate: 30 }
      return (await VideoEncoder.isConfigSupported(config)).supported
    } catch (err) {
      return String(err)
    }
  }
  return {
    chrome: navigator.userAgent.match(/Chrome\\/([\\d.]+)/)?.[1] ?? navigator.userAgent,
    viewport: \`\${innerWidth}x\${innerHeight} @\${devicePixelRatio}x\`,
    h264: await encodes('avc1.42001f'),
    hevc: await encodes('hvc1.1.6.L93.B0'),
  }
})()`

// Prints what the app's page and its workers log, with exceptions, until
// killed. The conversion runs in a worker, whose console is only reachable by
// attaching to it as a child target. Reconnects if the tab goes away.
async function watchConsole() {
  for (;;) {
    const page = await findPage(10 * 60_000)
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    let nextId = 1
    const send = (method, params = {}, sessionId) =>
      ws.send(JSON.stringify({ id: nextId++, method, params, ...(sessionId && { sessionId }) }))
    const sources = new Map()
    const print = (sessionId, kind, text) =>
      console.log(`${new Date().toISOString().slice(11, 19)} [${sources.get(sessionId) ?? 'page'}] ${kind}: ${text}`)
    await new Promise((resolve) => {
      ws.onopen = () => {
        send('Runtime.enable')
        send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
        print(undefined, 'watching', page.url)
      }
      ws.onmessage = (event) => {
        const { method, params, sessionId } = JSON.parse(event.data)
        if (method === 'Target.attachedToTarget') {
          sources.set(params.sessionId, params.targetInfo.type)
          send('Runtime.enable', {}, params.sessionId)
        } else if (method === 'Runtime.consoleAPICalled') {
          print(sessionId, params.type, params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
        } else if (method === 'Runtime.exceptionThrown') {
          const details = params.exceptionDetails
          print(sessionId, 'exception', details.exception?.description ?? details.text)
        }
      }
      ws.onclose = resolve
      ws.onerror = resolve
    })
    print(undefined, 'lost the page', 'reconnecting')
    await sleep(2000)
  }
}

async function main() {
  const [command, arg] = process.argv.slice(2)
  if (command === 'console') return watchConsole()
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
        log('browser', await app.evaluate(BROWSER))
        break
      }
      case 'shared': {
        const state = await app.waitFor(
          `(() => { const s = ${STATE}; return (s.file === ${literal(arg)} || s.error) ? s : null })()`,
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
        // Lifecycle and service worker events are kept in sessionStorage,
        // which survives a reload of the tab, to explain any reset later.
        await app.evaluate(`(() => {
          window.${MARKER} = true
          // Start fresh: an earlier conversion in this tab left its own events.
          sessionStorage.removeItem('${MARKER}Events')
          const note = (event) => {
            const key = '${MARKER}Events'
            const events = JSON.parse(sessionStorage.getItem(key) ?? '[]')
            events.push(\`\${new Date().toISOString().slice(11, 19)} \${event}\`)
            sessionStorage.setItem(key, JSON.stringify(events))
          }
          for (const type of ['visibilitychange', 'freeze', 'resume']) {
            document.addEventListener(type, () => note(\`\${type} \${document.visibilityState}\`))
          }
          navigator.serviceWorker.addEventListener('controllerchange', () => note('controllerchange'))
          window.addEventListener('pagehide', (e) => note(\`pagehide persisted=\${e.persisted}\`))
          window.addEventListener('beforeunload', () => note('beforeunload'))
          document.querySelector('.convert-button').click()
          return true
        })()`)
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
        // The whole conversion takes a minute or two on the emulator.
        const end = Date.now() + 5 * 60_000
        let lastLog = 0
        let reloaded = false
        let idleSince = null
        // Last time the page answered with a progress it hadn't shown before.
        let lastProgress = null
        let movedAt = Date.now()
        for (;;) {
          const state = await app.evaluate(STATE).catch(app.unlessClosed)
          if (state && state.progress !== lastProgress) {
            lastProgress = state.progress
            movedAt = Date.now()
          }
          if (Date.now() - movedAt > 90_000) {
            log('stuck', state)
            throw new Error(state
              ? `the conversion made no progress for 90 seconds (stuck at ${state.progress ?? 'no progress'})`
              : 'the page stopped responding for 90 seconds')
          }
          if (state) {
            if (state.result || state.error) {
              log('finished', state)
              if (state.error) throw new Error(`the app showed an error: ${state.error}`)
              break
            }
            // A reload while backgrounded is allowed as long as the app picks
            // the conversion back up by itself; sitting idle means it was lost.
            if (!state.sameDocument && !reloaded) {
              reloaded = true
              log('page reloaded while in the background', state)
            }
            const idle = !state.progress && state.button?.trim() === 'Convert'
            idleSince = idle ? (idleSince ?? Date.now()) : null
            if (idleSince && Date.now() - idleSince > 60_000) {
              log('lost', state)
              throw new Error(reloaded
                ? 'the page reloaded in the background and the conversion did not resume'
                : 'the conversion stopped without a result')
            }
            if (Date.now() - lastLog > 30_000) {
              lastLog = Date.now()
              log('still converting', state)
            }
          }
          if (Date.now() > end) throw new Error('timed out waiting for the conversion to finish')
          await sleep(2000)
        }
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
