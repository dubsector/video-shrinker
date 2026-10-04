// Serves a web build (dist/) over HTTPS at /video-shrinker/, the way GitHub
// Pages does, so the emulator's Chrome can load it in place of the live site.
//
// Usage: node serve.mjs DIST_DIR CERT_PEM KEY_PEM PORT

import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const [root, certFile, keyFile, port] = process.argv.slice(2)
const BASE = '/video-shrinker/'
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
}

async function resolve(pathname) {
  const file = normalize(join(root, decodeURIComponent(pathname.slice(BASE.length))))
  if (!file.startsWith(normalize(root))) return null
  const info = await stat(file).catch(() => null)
  if (info?.isFile()) return file
  if (info?.isDirectory()) return resolve(`${pathname.replace(/\/$/, '')}/index.html`)
  return null
}

createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, async (req, res) => {
  const { pathname } = new URL(req.url, 'https://localhost')
  const file = pathname.startsWith(BASE) && req.method === 'GET' ? await resolve(pathname) : null
  if (!file) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(await readFile(file))
}).listen(Number(port), '127.0.0.1', () => console.log(`serving ${root} on https://127.0.0.1:${port}${BASE}`))
