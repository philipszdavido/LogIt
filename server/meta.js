'use strict'

// Session summaries shared by every storage backend.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const ASSET_ID_RE = /^[a-f0-9]{64}$/

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined
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

// Folds one ingested batch into a summary. Applied to an empty summary it yields the batch's delta,
// which is how the Postgres store merges concurrent writes atomically.
function updateMeta(meta, batch, bytes) {
  meta.sizeBytes += bytes
  meta.receivedAt = Date.now()
  if (batch.user && typeof batch.user === 'object') meta.user = sanitizeUser(batch.user) || meta.user
  for (const ev of batch.events) {
    meta.eventCount++
    if (ev.t < meta.startedAt) meta.startedAt = ev.t
    if (ev.t > meta.lastEventAt) meta.lastEventAt = ev.t
    const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
    switch (ev.type) {
      case 'meta':
        meta.pageCount++
        if (!meta.firstUrl) meta.firstUrl = clip(d.href, 2000) || null
        meta.lastUrl = clip(d.href, 2000) || meta.lastUrl
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
        meta.user = sanitizeUser(d) || meta.user
        break
    }
  }
  if (meta.startedAt === Infinity) meta.startedAt = meta.lastEventAt
  return meta
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

function matchesQuery(meta, needle) {
  const haystack = [meta.sessionId, meta.firstUrl, meta.lastUrl, meta.user && meta.user.id, meta.user && JSON.stringify(meta.user.traits || {})]
  return haystack.some(v => v && String(v).toLowerCase().includes(needle))
}

module.exports = { ID_RE, ASSET_ID_RE, newMeta, updateMeta, sanitizeUser, matchesQuery }
