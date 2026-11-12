'use strict'

const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined
}

/**
 * File-backed session store.
 *
 *   <dataDir>/<appId>/<sessionId>/events.ndjson  one line per ingested batch
 *   <dataDir>/<appId>/<sessionId>/meta.json      summary used by the session list
 *
 * Session summaries are kept in memory for listing; writes to one session are serialized.
 */
class SessionStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir)
    this.index = new Map()
    this.queues = new Map()
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true })
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

  _dir(appId, sessionId) {
    if (!ID_RE.test(appId) || !ID_RE.test(sessionId)) throw new Error('invalid id')
    return path.join(this.dataDir, appId, sessionId)
  }

  _metaPath(appId, sessionId) {
    return path.join(this._dir(appId, sessionId), 'meta.json')
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
      const tmp = this._metaPath(appId, sessionId) + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify(meta))
      await fsp.rename(tmp, this._metaPath(appId, sessionId))
      return meta
    })
  }

  apps() {
    const counts = new Map()
    for (const meta of this.index.values()) counts.set(meta.appId, (counts.get(meta.appId) || 0) + 1)
    return [...counts].map(([appId, sessions]) => ({ appId, sessions })).sort((a, b) => a.appId.localeCompare(b.appId))
  }

  list({ appId, q, limit = 50, offset = 0, errorsOnly = false } = {}) {
    const needle = (q || '').toLowerCase()
    let sessions = [...this.index.values()].filter(m => {
      if (appId && m.appId !== appId) return false
      if (errorsOnly && !m.errorCount) return false
      if (!needle) return true
      const haystack = [m.sessionId, m.firstUrl, m.lastUrl, m.user && m.user.id, m.user && JSON.stringify(m.user.traits || {})]
      return haystack.some(v => v && String(v).toLowerCase().includes(needle))
    })
    sessions.sort((a, b) => b.lastEventAt - a.lastEventAt)
    const total = sessions.length
    sessions = sessions.slice(offset, offset + limit)
    return { total, sessions }
  }

  getMeta(appId, sessionId) {
    return this.index.get(key(appId, sessionId)) || null
  }

  async getEvents(appId, sessionId) {
    if (!this.getMeta(appId, sessionId)) return null
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

function newMeta(appId, sessionId) {
  return {
    appId,
    sessionId,
    startedAt: Infinity,
    lastEventAt: 0,
    receivedAt: Date.now(),
    eventCount: 0,
    errorCount: 0,
    failedRequests: 0,
    slowRequests: 0,
    pageCount: 0,
    firstUrl: null,
    lastUrl: null,
    userAgent: null,
    viewport: null,
    user: null,
    sizeBytes: 0
  }
}

function updateMeta(meta, batch, bytes) {
  meta.sizeBytes += bytes
  meta.receivedAt = Date.now()
  if (batch.user && typeof batch.user === 'object') meta.user = sanitizeUser(batch.user)
  for (const ev of batch.events) {
    meta.eventCount++
    if (ev.t < meta.startedAt) meta.startedAt = ev.t
    if (ev.t > meta.lastEventAt) meta.lastEventAt = ev.t
    const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
    switch (ev.type) {
      case 'meta':
        meta.pageCount++
        if (!meta.firstUrl) meta.firstUrl = clip(d.href, 2000)
        meta.lastUrl = clip(d.href, 2000)
        meta.userAgent = clip(d.userAgent, 500) || meta.userAgent
        if (d.viewport) meta.viewport = { width: +d.viewport.width || 0, height: +d.viewport.height || 0 }
        break
      case 'nav':
        meta.lastUrl = clip(d.href, 2000) || meta.lastUrl
        break
      case 'error':
        meta.errorCount++
        break
      case 'console':
        if (d.level === 'error') meta.errorCount++
        break
      case 'network':
        if (!d.status || d.status >= 500) meta.failedRequests++
        if (d.slow) meta.slowRequests++
        break
      case 'identify':
        meta.user = sanitizeUser(d)
        break
    }
  }
  if (meta.startedAt === Infinity) meta.startedAt = meta.lastEventAt
}

function sanitizeUser(user) {
  if (!user || user.id == null) return null
  let traits
  try {
    traits = user.traits && typeof user.traits === 'object' ? JSON.parse(JSON.stringify(user.traits).slice(0, 2000)) : undefined
  } catch (e) {
    traits = undefined
  }
  return { id: String(user.id).slice(0, 200), traits }
}

module.exports = { SessionStore, ID_RE }
