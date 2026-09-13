'use strict'

// Drop-in for extract-zip@1's callback API, minus the parts that let a
// crafted archive write outside the destination: symlink entries are
// refused outright and every path is re-checked after mkdir.
// See CVE-2026-19693 and CVE-2026-56876.

const fs = require('fs')
const path = require('path')
const { pipeline } = require('stream/promises')
const yauzl = require('yauzl')

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const DOS_DIRECTORY = 0x10
const DEFAULT_FILE_MODE = 0o644

// O_NOFOLLOW is POSIX only. On Windows the lstat check below covers the
// same case: a destination that already exists as a link.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_NOFOLLOW

function isUnsafeName (name) {
  if (name === '' || path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) return true
  return name.split(/[/\\]/).some((part) => part === '..')
}

function assertInside (dir, target, name) {
  const relative = path.relative(dir, target)
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`Out of bound path "${target}" found while processing file ${name}`)
  }
}

async function assertNotLink (dest) {
  try {
    const stats = await fs.promises.lstat(dest)
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to write through existing symlink "${dest}"`)
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

function openZip (zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) reject(err)
      else resolve(zipfile)
    })
  })
}

function openReadStream (zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) reject(err)
      else resolve(stream)
    })
  })
}

function entryMode (entry) {
  return (entry.externalFileAttributes >>> 16) & 0xFFFF
}

function isDirectoryEntry (entry, mode) {
  if ((mode & S_IFMT) === S_IFDIR) return true
  if (entry.fileName.endsWith('/')) return true
  // Archives made on DOS/Windows carry no unix mode, just the dir attribute.
  if ((entry.versionMadeBy >> 8) === 0) return (entry.externalFileAttributes & DOS_DIRECTORY) !== 0
  return false
}

async function extractEntry (zipfile, entry, dir, opts) {
  const name = entry.fileName
  if (name.startsWith('__MACOSX/')) return
  if (isUnsafeName(name)) throw new Error(`Refusing to extract unsafe path "${name}"`)

  const mode = entryMode(entry)
  if ((mode & S_IFMT) === S_IFLNK) {
    throw new Error(`Refusing to extract symlink entry "${name}"`)
  }

  if (opts.onEntry) opts.onEntry(entry, zipfile)

  const dest = path.join(dir, name)
  const isDir = isDirectoryEntry(entry, mode)
  const destDir = isDir ? dest : path.dirname(dest)

  await fs.promises.mkdir(destDir, { recursive: true })
  assertInside(dir, await fs.promises.realpath(destDir), name)
  if (isDir) return

  await assertNotLink(dest)
  const fileMode = (mode & 0o7777) || parseInt(opts.defaultFileMode, 10) || DEFAULT_FILE_MODE
  const readStream = await openReadStream(zipfile, entry)
  await pipeline(readStream, fs.createWriteStream(dest, { flags: WRITE_FLAGS, mode: fileMode }))
}

function readEntries (zipfile, handler) {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      zipfile.close()
      reject(err)
    }

    zipfile.on('error', fail)
    zipfile.on('end', () => {
      if (!settled) {
        settled = true
        resolve()
      }
    })
    zipfile.on('entry', (entry) => {
      handler(entry).then(() => {
        if (!settled) zipfile.readEntry()
      }, fail)
    })
    zipfile.readEntry()
  })
}

async function extract (zipPath, opts) {
  if (!opts.dir) throw new Error('Target directory is required')
  if (!path.isAbsolute(opts.dir)) throw new Error('Target directory is expected to be absolute')

  await fs.promises.mkdir(opts.dir, { recursive: true })
  const dir = await fs.promises.realpath(opts.dir)
  const zipfile = await openZip(zipPath)
  await readEntries(zipfile, (entry) => extractEntry(zipfile, entry, dir, opts))
}

module.exports = function extractZip (zipPath, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }

  const promise = extract(zipPath, opts || {})
  if (typeof cb !== 'function') return promise
  promise.then(() => cb(null), cb)
}
