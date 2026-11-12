'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { SessionStore, ID_RE } = require('./store')

const ROOT = path.resolve(__dirname, '..')
const MAX_EVENTS_PER_BATCH = 5000

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

// The replay iframe inherits this policy: recorded scripts are blocked, recorded styles/images/fonts load.
const VIEWER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src * 'unsafe-inline'",
  'img-src * data: blob:',
  'font-src * data:',
  'media-src * data: blob:',
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

function list(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean)
}

function configFromEnv(env = process.env) {
  const production = env.NODE_ENV === 'production'
  return {
    port: Number(env.PORT || 4000),
    host: env.HOST || '0.0.0.0',
    dataDir: env.LOGIT_DATA_DIR || path.join(ROOT, 'data'),
    adminToken: env.LOGIT_ADMIN_TOKEN || '',
    allowedAppIds: list(env.LOGIT_ALLOWED_APP_IDS),
    allowedOrigins: list(env.LOGIT_ALLOWED_ORIGINS || '*'),
    retentionDays: Number(env.LOGIT_RETENTION_DAYS || 30),
    maxBodyBytes: Number(env.LOGIT_MAX_BODY_BYTES || 10 * 1024 * 1024),
    rateLimitPerMinute: Number(env.LOGIT_RATE_LIMIT_PER_MINUTE || 600),
    trustProxy: env.LOGIT_TRUST_PROXY === 'true',
    serveDemo: env.LOGIT_SERVE_DEMO ? env.LOGIT_SERVE_DEMO === 'true' : !production,
    production,
    log: env.LOGIT_QUIET === 'true' ? () => {} : (...args) => console.log(new Date().toISOString(), ...args)
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > limit * 4) {
      req.destroy()
      return reject(new HttpError(413, 'Payload too large'))
    }
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) tooLarge = true
      if (!tooLarge) chunks.push(chunk)
    })
    // Drain an oversized body instead of resetting the socket so the client still gets the 413.
    req.on('end', () => (tooLarge ? reject(new HttpError(413, 'Payload too large')) : resolve(Buffer.concat(chunks))))
    req.on('error', reject)
  })
}

function validateBatch(b, config) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be a JSON object'
  for (const field of ['appId', 'sessionId', 'pageId']) {
    if (typeof b[field] !== 'string' || !ID_RE.test(b[field])) return `invalid ${field}`
  }
  if (config.allowedAppIds.length && !config.allowedAppIds.includes(b.appId)) return 'unknown appId'
  if (!Array.isArray(b.events) || !b.events.length) return 'events must be a non-empty array'
  if (b.events.length > MAX_EVENTS_PER_BATCH) return 'too many events in batch'
  for (let i = 0; i < b.events.length; i++) {
    const ev = b.events[i]
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string' || ev.type.length > 32 ||
        typeof ev.t !== 'number' || !Number.isFinite(ev.t)) {
      return `invalid event at index ${i}`
    }
  }
  if (b.seq != null && !Number.isInteger(b.seq)) return 'invalid seq'
  return null
}

function hashToken(t) {
  return crypto.createHash('sha256').update(String(t)).digest()
}

function createRateLimiter(perMinute) {
  const hits = new Map()
  const timer = setInterval(() => hits.clear(), 60 * 1000)
  timer.unref()
  return {
    allow(ip) {
      if (!perMinute) return true
      const n = (hits.get(ip) || 0) + 1
      hits.set(ip, n)
      return n <= perMinute
    },
    stop() { clearInterval(timer) }
  }
}

async function createApp(overrides = {}) {
  const config = Object.assign(configFromEnv(), overrides)
  if (config.production && !config.adminToken) {
    throw new Error('LOGIT_ADMIN_TOKEN must be set when NODE_ENV=production')
  }
  const store = new SessionStore(config.dataDir)
  await store.init()
  const limiter = createRateLimiter(config.rateLimitPerMinute)
  const tokenHash = config.adminToken ? hashToken(config.adminToken) : null

  const staticRoutes = [
    { prefix: '/viewer/', dir: path.join(ROOT, 'viewer'), viewer: true },
    { prefix: '/sdk/', dir: path.join(ROOT, 'src'), alias: { 'logit.js': 'recorder.js' }, cache: 'public, max-age=300' }
  ]
  if (config.serveDemo) staticRoutes.push({ prefix: '/demo/', dir: path.join(ROOT, 'demo') })

  function clientIp(req) {
    if (config.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim()
    return req.socket.remoteAddress || 'unknown'
  }

  function authorized(req) {
    if (!tokenHash) return true
    const header = String(req.headers.authorization || '')
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    return crypto.timingSafeEqual(hashToken(token), tokenHash)
  }

  function applyIngestCors(req, res) {
    const origin = req.headers.origin
    if (config.allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      return true
    }
    res.setHeader('Vary', 'Origin')
    if (!origin) return true // same-origin or non-browser client
    if (!config.allowedOrigins.includes(origin)) return false
    res.setHeader('Access-Control-Allow-Origin', origin)
    return true
  }

  async function handleIngest(req, res) {
    const corsOk = applyIngestCors(req, res)
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Max-Age', '86400')
      res.writeHead(corsOk ? 204 : 403)
      return res.end()
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
    if (!corsOk) throw new HttpError(403, 'Origin not allowed')
    if (!limiter.allow(clientIp(req))) throw new HttpError(429, 'Too many requests')

    const raw = await readBody(req, config.maxBodyBytes)
    let batch
    try {
      batch = JSON.parse(raw.toString('utf8'))
    } catch (e) {
      throw new HttpError(400, 'invalid JSON')
    }
    const problem = validateBatch(batch, config)
    if (problem) throw new HttpError(400, problem)
    await store.append(batch)
    sendJson(res, 202, { ok: true })
  }

  async function handleApi(req, res, url) {
    if (!authorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      throw new HttpError(401, 'Unauthorized')
    }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent) // ['api', ...]

    if (parts[1] === 'apps' && parts.length === 2 && req.method === 'GET') {
      return sendJson(res, 200, { apps: store.apps() })
    }

    if (parts[1] === 'sessions' && parts.length === 2 && req.method === 'GET') {
      const p = url.searchParams
      const limit = Math.min(Math.max(parseInt(p.get('limit'), 10) || 50, 1), 500)
      const offset = Math.max(parseInt(p.get('offset'), 10) || 0, 0)
      return sendJson(res, 200, store.list({
        appId: p.get('appId') || undefined,
        q: p.get('q') || undefined,
        errorsOnly: p.get('errors') === '1',
        limit,
        offset
      }))
    }

    if (parts[1] === 'sessions' && parts.length === 4) {
      const [, , appId, sessionId] = parts
      if (!ID_RE.test(appId) || !ID_RE.test(sessionId)) throw new HttpError(400, 'invalid id')
      if (req.method === 'GET') {
        const meta = store.getMeta(appId, sessionId)
        const events = meta && await store.getEvents(appId, sessionId)
        if (!events) throw new HttpError(404, 'Session not found')
        return sendJson(res, 200, { meta, events })
      }
      if (req.method === 'DELETE') {
        if (!(await store.delete(appId, sessionId))) throw new HttpError(404, 'Session not found')
        res.writeHead(204)
        return res.end()
      }
      throw new HttpError(405, 'Method not allowed')
    }

    throw new HttpError(404, 'Not found')
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    for (const route of staticRoutes) {
      if (!url.pathname.startsWith(route.prefix)) continue
      let rel = decodeURIComponent(url.pathname.slice(route.prefix.length)) || 'index.html'
      if (route.alias && route.alias[rel]) rel = route.alias[rel]
      const file = path.resolve(route.dir, rel)
      if (!file.startsWith(route.dir + path.sep)) throw new HttpError(404, 'Not found')
      let stat
      try {
        stat = fs.statSync(file)
      } catch (e) {
        throw new HttpError(404, 'Not found')
      }
      if (!stat.isFile()) throw new HttpError(404, 'Not found')
      const headers = {
        'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': route.cache || 'no-cache'
      }
      if (route.prefix === '/sdk/') headers['Access-Control-Allow-Origin'] = '*'
      if (route.viewer) {
        headers['Content-Security-Policy'] = VIEWER_CSP
        headers['X-Frame-Options'] = 'DENY'
      }
      res.writeHead(200, headers)
      if (req.method === 'HEAD') res.end()
      else fs.createReadStream(file).pipe(res)
      return true
    }
    return false
  }

  async function handle(req, res) {
    const started = Date.now()
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    let url
    res.on('finish', () => {
      if (url && url.pathname !== '/api/ingest' && url.pathname !== '/healthz') {
        config.log(req.method, req.url, res.statusCode, Date.now() - started + 'ms')
      }
    })
    try {
      url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/api/ingest') await handleIngest(req, res)
      else if (url.pathname.startsWith('/api/')) await handleApi(req, res, url)
      else if (url.pathname === '/healthz') sendJson(res, 200, { ok: true, sessions: store.index.size })
      else if (url.pathname === '/' || url.pathname === '/viewer') {
        res.writeHead(302, { Location: '/viewer/' })
        res.end()
      } else if (config.serveDemo && url.pathname === '/demo/api/slow') {
        const ms = Math.min(Number(url.searchParams.get('ms')) || 1500, 10000)
        setTimeout(() => sendJson(res, 200, { ok: true, delayedMs: ms }), ms)
      } else if (config.serveDemo && url.pathname === '/demo') {
        res.writeHead(302, { Location: '/demo/' })
        res.end()
      } else if (!serveStatic(req, res, url)) {
        throw new HttpError(404, 'Not found')
      }
    } catch (err) {
      const status = err.status || (err instanceof URIError ? 400 : 500)
      if (status >= 500) config.log('error', req.method, req.url, err.stack || err)
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? 'Internal server error' : err.message })
      else res.end()
    }
  }

  const server = http.createServer((req, res) => { handle(req, res) })
  server.keepAliveTimeout = 65 * 1000
  server.requestTimeout = 30 * 1000

  const retentionMs = config.retentionDays * 24 * 60 * 60 * 1000
  const pruneTimer = config.retentionDays > 0
    ? setInterval(() => {
      store.prune(retentionMs).then(n => n && config.log(`retention: removed ${n} session(s)`))
        .catch(err => config.log('retention error', err))
    }, 60 * 60 * 1000)
    : null
  if (pruneTimer) pruneTimer.unref()
  if (config.retentionDays > 0) await store.prune(retentionMs)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  const address = server.address()
  const host = address.address === '0.0.0.0' || address.address === '::' ? 'localhost' : address.address

  return {
    server,
    store,
    config,
    url: `http://${host}:${address.port}`,
    async close() {
      if (pruneTimer) clearInterval(pruneTimer)
      limiter.stop()
      await new Promise(resolve => server.close(resolve))
      server.closeAllConnections && server.closeAllConnections()
      await store.drain()
    }
  }
}

if (require.main === module) {
  createApp().then(app => {
    const { config } = app
    config.log(`LogIt server listening on ${app.url}`)
    config.log(`viewer: ${app.url}/viewer/   sdk: ${app.url}/sdk/logit.js${config.serveDemo ? `   demo: ${app.url}/demo/` : ''}`)
    if (!config.adminToken) config.log('WARNING: LOGIT_ADMIN_TOKEN is not set; the session API is unauthenticated')
    let closing = false
    const shutdown = signal => {
      if (closing) return
      closing = true
      config.log(`${signal} received, shutting down`)
      app.close().then(() => process.exit(0), () => process.exit(1))
      setTimeout(() => process.exit(1), 10000).unref()
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  }).catch(err => {
    console.error(err.message || err)
    process.exit(1)
  })
}

module.exports = { createApp, configFromEnv, validateBatch }
