'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createApp } = require('../server')

const TOKEN = 'test-token'
let app
let dataDir

function batch(overrides = {}) {
  return Object.assign({
    appId: 'shop',
    sessionId: 'sess-1',
    pageId: 'page-1',
    seq: 0,
    events: [
      { t: 1000, type: 'meta', data: { href: 'https://shop.test/', userAgent: 'UA' } },
      { t: 1500, type: 'error', data: { message: 'boom' } },
      { t: 2000, type: 'network', data: { status: 500, duration: 2000, slow: true } }
    ]
  }, overrides)
}

function ingest(body, headers = {}) {
  return fetch(app.url + '/api/ingest', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'text/plain' }, headers),
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

function apiGet(p, token = TOKEN) {
  return fetch(app.url + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logit-test-'))
  app = await createApp({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    adminToken: TOKEN,
    allowedOrigins: ['https://shop.test'],
    allowedAppIds: [],
    maxBodyBytes: 50000,
    rateLimitPerMinute: 0,
    retentionDays: 0,
    serveDemo: true,
    log: () => {}
  })
})

after(async () => {
  await app.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('ingests a batch and summarizes the session', async () => {
  const res = await ingest(batch(), { Origin: 'https://shop.test' })
  assert.equal(res.status, 202)
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://shop.test')

  await ingest(batch({ seq: 1, events: [
    { t: 3000, type: 'identify', data: { id: 'user-42', traits: { plan: 'pro' } } },
    { t: 4000, type: 'nav', data: { href: 'https://shop.test/cart' } }
  ] }))

  const list = await (await apiGet('/api/sessions?appId=shop')).json()
  assert.equal(list.total, 1)
  const meta = list.sessions[0]
  assert.equal(meta.sessionId, 'sess-1')
  assert.equal(meta.startedAt, 1000)
  assert.equal(meta.lastEventAt, 4000)
  assert.equal(meta.eventCount, 5)
  assert.equal(meta.errorCount, 1)
  assert.equal(meta.failedRequests, 1)
  assert.equal(meta.slowRequests, 1)
  assert.equal(meta.firstUrl, 'https://shop.test/')
  assert.equal(meta.lastUrl, 'https://shop.test/cart')
  assert.deepEqual(meta.user, { id: 'user-42', traits: { plan: 'pro' } })
})

test('returns all events of a session', async () => {
  const res = await apiGet('/api/sessions/shop/sess-1')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.events.length, 5)
  assert.deepEqual(body.events.map(e => e.type), ['meta', 'error', 'network', 'identify', 'nav'])
})

test('search and app listing', async () => {
  await ingest(batch({ appId: 'blog', sessionId: 'sess-2' }))
  const apps = await (await apiGet('/api/apps')).json()
  assert.deepEqual(apps.apps, [{ appId: 'blog', sessions: 1 }, { appId: 'shop', sessions: 1 }])
  const found = await (await apiGet('/api/sessions?q=user-42')).json()
  assert.deepEqual(found.sessions.map(s => s.sessionId), ['sess-1'])
})

test('rejects invalid batches', async () => {
  assert.equal((await ingest('not json')).status, 400)
  assert.equal((await ingest(batch({ appId: '../etc' }))).status, 400)
  assert.equal((await ingest(batch({ sessionId: 'a/b' }))).status, 400)
  assert.equal((await ingest(batch({ events: [] }))).status, 400)
  assert.equal((await ingest(batch({ events: [{ type: 'x' }] }))).status, 400)
  assert.equal((await ingest(batch({ events: [{ t: 'soon', type: 'x' }] }))).status, 400)
  const res = await ingest(batch())
  assert.equal(res.status, 202)
})

test('rejects disallowed origins and oversized bodies', async () => {
  assert.equal((await ingest(batch(), { Origin: 'https://evil.test' })).status, 403)
  const big = batch({ events: [{ t: 1, type: 'console', data: { args: ['x'.repeat(60000)] } }] })
  assert.equal((await ingest(big)).status, 413)
})

test('answers CORS preflight for ingest', async () => {
  const res = await fetch(app.url + '/api/ingest', { method: 'OPTIONS', headers: { Origin: 'https://shop.test' } })
  assert.equal(res.status, 204)
  assert.match(res.headers.get('access-control-allow-methods'), /POST/)
})

test('session API requires the admin token', async () => {
  assert.equal((await apiGet('/api/sessions', null)).status, 401)
  assert.equal((await apiGet('/api/sessions', 'wrong')).status, 401)
  assert.equal((await apiGet('/api/sessions/shop/missing')).status, 404)
  assert.equal((await apiGet('/api/sessions/shop/..%2F..')).status, 400)
})

test('serves the SDK, viewer with CSP, and blocks traversal', async () => {
  const sdk = await fetch(app.url + '/sdk/logit.js')
  assert.equal(sdk.status, 200)
  assert.match(await sdk.text(), /LogIt recorder SDK/)
  const viewer = await fetch(app.url + '/viewer/')
  assert.equal(viewer.status, 200)
  assert.match(viewer.headers.get('content-security-policy'), /script-src 'self'/)
  assert.equal((await fetch(app.url + '/viewer/..%2F..%2Fpackage.json')).status, 404)
  assert.equal((await fetch(app.url + '/sdk/%E0%A4%A')).status, 400)
})

test('deletes sessions', async () => {
  const res = await fetch(app.url + '/api/sessions/blog/sess-2', { method: 'DELETE', headers: { Authorization: 'Bearer ' + TOKEN } })
  assert.equal(res.status, 204)
  assert.equal((await apiGet('/api/sessions/blog/sess-2')).status, 404)
  assert.equal(fs.existsSync(path.join(dataDir, 'blog', 'sess-2')), false)
})

test('reloads the session index from disk', async () => {
  const { SessionStore } = require('../server/store')
  const store = new SessionStore(dataDir)
  await store.init()
  assert.equal((await store.getMeta('shop', 'sess-1')).eventCount, 8)
})

test('refuses to start in production without a token', async () => {
  await assert.rejects(createApp({ production: true, adminToken: '', port: 0, dataDir, log: () => {} }), /LOGIT_ADMIN_TOKEN/)
})
