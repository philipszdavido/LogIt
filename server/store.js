'use strict'

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { ID_RE, ASSET_ID_RE, newMeta, updateMeta, matchesQuery } = require('./meta')

/**
 * File-backed store for a single server instance (use the Postgres store to run several).
 *
 *   <dataDir>/<appId>/<sessionId>/events.ndjson  one line per ingested batch
 *   <dataDir>/<appId>/<sessionId>/meta.json      summary used by the session list
 *   <dataDir>/<appId>/<sessionId>/assets.json    original URL -> archived asset hash
 *   <dataDir>/.assets/<hh>/<hash>(.type)         archived assets, content-addressed
 *
 * Session summaries are kept in memory for listing; writes to one session are serialized.
 */
class FileStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir)
    this.assetDir = path.join(this.dataDir, '.assets') // '.' is not allowed in app ids, so no clash
    this.index = new Map()
    this.queues = new Map()
  }

  async init() {
    await fsp.mkdir(this.assetDir, { recursive: true })
    for (const appId of await safeReaddir(this.dataDir)) {
      if (!ID_RE.test(appId)) continue
      for (const sessionId of await safeReaddir(path.join(this.dataDir, appId))) {
        if (!ID_RE.test(sessionId)) continue
        try {
          const meta = JSON.parse(await fsp.readFile(this._metaPath(appId, sessionId), 'utf8'))
          this.index.set(key(appId, sessionId), meta)
        } catch (e) {
          // Session without a readable summary: skip it rather than fail startup.
        }
      }
    }
  }

  async close() {
    await this.drain()
  }

  _dir(appId, sessionId) {
    if (!ID_RE.test(appId) || !ID_RE.test(sessionId)) throw new Error('invalid id')
    return path.join(this.dataDir, appId, sessionId)
  }

  _metaPath(appId, sessionId) {
    return path.join(this._dir(appId, sessionId), 'meta.json')
  }

  _assetPath(hash) {
    if (!ASSET_ID_RE.test(hash)) throw new Error('invalid asset id')
    return path.join(this.assetDir, hash.slice(0, 2), hash)
  }

  _enqueue(k, fn) {
    const prev = this.queues.get(k) || Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this.queues.set(k, next)
    next.catch(() => {}).then(() => {
      if (this.queues.get(k) === next) this.queues.delete(k)
    })
    return next
  }

  append(batch) {
    const { appId, sessionId } = batch
    const k = key(appId, sessionId)
    return this._enqueue(k, async () => {
      const dir = this._dir(appId, sessionId)
      await fsp.mkdir(dir, { recursive: true })
      const line = JSON.stringify({
        pageId: batch.pageId,
        seq: batch.seq,
        receivedAt: Date.now(),
        events: batch.events
      }) + '\n'
      await fsp.appendFile(path.join(dir, 'events.ndjson'), line)

      const meta = this.index.get(k) || newMeta(appId, sessionId)
      updateMeta(meta, batch, Buffer.byteLength(line))
      this.index.set(k, meta)
      await writeAtomic(this._metaPath(appId, sessionId), JSON.stringify(meta))
      return meta
    })
  }

  async count() {
    return this.index.size
  }

  async apps() {
    const counts = new Map()
    for (const meta of this.index.values()) counts.set(meta.appId, (counts.get(meta.appId) || 0) + 1)
    return [...counts].map(([appId, sessions]) => ({ appId, sessions })).sort((a, b) => a.appId.localeCompare(b.appId))
  }

  async list({ appId, q, limit = 50, offset = 0, errorsOnly = false } = {}) {
    const needle = (q || '').toLowerCase()
    const sessions = [...this.index.values()].filter(m => {
      if (appId && m.appId !== appId) return false
      if (errorsOnly && !m.errorCount) return false
      return !needle || matchesQuery(m, needle)
    })
    sessions.sort((a, b) => b.lastEventAt - a.lastEventAt)
    return { total: sessions.length, sessions: sessions.slice(offset, offset + limit) }
  }

  async getMeta(appId, sessionId) {
    return this.index.get(key(appId, sessionId)) || null
  }

  async getEvents(appId, sessionId) {
    if (!this.index.has(key(appId, sessionId))) return null
    await (this.queues.get(key(appId, sessionId)) || Promise.resolve()).catch(() => {})
    let raw
    try {
      raw = await fsp.readFile(path.join(this._dir(appId, sessionId), 'events.ndjson'), 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
    const events = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const batch = JSON.parse(line)
        for (const ev of batch.events) events.push(ev)
      } catch (e) {
        // A torn last line (crash mid-write) only loses that batch.
      }
    }
    return events
  }

  delete(appId, sessionId) {
    const k = key(appId, sessionId)
    return this._enqueue(k, async () => {
      const existed = this.index.delete(k)
      await fsp.rm(this._dir(appId, sessionId), { recursive: true, force: true })
      return existed
    })
  }

  async prune(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs
    let removed = 0
    for (const meta of [...this.index.values()]) {
      if (meta.lastEventAt < cutoff) {
        await this.delete(meta.appId, meta.sessionId)
        removed++
      }
    }
    return removed
  }

  async drain() {
    await Promise.all([...this.queues.values()].map(p => p.catch(() => {})))
  }

  // ---------------------------------------------------------------- assets

  async hasAsset(hash) {
    try {
      await fsp.access(this._assetPath(hash))
      return true
    } catch (e) {
      return false
    }
  }

  async putAsset(hash, contentType, body) {
    const file = this._assetPath(hash)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await writeAtomic(file + '.type', contentType)
    await writeAtomic(file, body)
  }

  async getAsset(hash) {
    const file = this._assetPath(hash)
    try {
      const [body, contentType] = await Promise.all([fsp.readFile(file), fsp.readFile(file + '.type', 'utf8')])
      return { body, contentType }
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }

  addSessionAssets(appId, sessionId, map) {
    const k = key(appId, sessionId)
    return this._enqueue(k, async () => {
      if (!this.index.has(k)) return // deleted meanwhile
      const file = path.join(this._dir(appId, sessionId), 'assets.json')
      const current = await readJson(file, {})
      await writeAtomic(file, JSON.stringify(Object.assign(current, map)))
    })
  }

  async getSessionAssets(appId, sessionId) {
    return readJson(path.join(this._dir(appId, sessionId), 'assets.json'), {})
  }

  // Removes archived assets no session references any more (older than graceMs, so in-flight archiving is safe).
  async gcAssets(graceMs) {
    const referenced = new Set()
    for (const meta of this.index.values()) {
      const map = await this.getSessionAssets(meta.appId, meta.sessionId)
      for (const hash of Object.values(map)) referenced.add(hash)
    }
    const cutoff = Date.now() - graceMs
    let removed = 0
    for (const shard of await safeReaddir(this.assetDir)) {
      for (const name of await safeReaddir(path.join(this.assetDir, shard))) {
        if (!ASSET_ID_RE.test(name) || referenced.has(name)) continue
        const file = path.join(this.assetDir, shard, name)
        try {
          if ((await fsp.stat(file)).mtimeMs > cutoff) continue
          await fsp.rm(file, { force: true })
          await fsp.rm(file + '.type', { force: true })
          removed++
        } catch (e) { /* raced with another delete */ }
      }
    }
    return removed
  }
}

function key(appId, sessionId) {
  return appId + '/' + sessionId
}

async function safeReaddir(dir) {
  try {
    return await fsp.readdir(dir)
  } catch (e) {
    return []
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (e) {
    return fallback
  }
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

function createStore(config) {
  if (config.databaseUrl) {
    const { PgStore } = require('./pg-store')
    return new PgStore(config.databaseUrl, { poolSize: config.dbPoolSize })
  }
  return new FileStore(config.dataDir)
}

module.exports = { FileStore, SessionStore: FileStore, createStore, ID_RE, ASSET_ID_RE }
