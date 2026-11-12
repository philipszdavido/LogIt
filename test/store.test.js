'use strict'

// One contract, two backends: the file store and the Postgres store must behave identically.
// The Postgres suite also checks multi-instance behavior (two stores / two servers on one database).

const { describe, test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { FileStore } = require('../server/store')
const { createApp } = require('../server')
const { startPostgres } = require('./helpers/postgres')

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function batch(sessionId, events, extra = {}) {
  return Object.assign({ appId: 'shop', sessionId, pageId: 'p1', seq: 0, events }, extra)
}

const pageEvents = [
  { t: 1000, type: 'meta', data: { href: 'https://shop.test/', userAgent: 'UA', viewport: { width: 800, height: 600 } } },
  { t: 1100, type: 'console', data: { level: 'error', args: ['x'] } },
  { t: 1200, type: 'network', data: { status: 503, slow: true } }
]

function contract(name, makeStore) {
  describe(name, () => {
    let store

    before(async () => {
      store = await makeStore()
      if (!store) return
      await store.init()
    })

    after(async () => {
      if (store) await store.close()
    })

    test('merges concurrent batches into one summary', async () => {
      await store.append(batch('s1', pageEvents))
      // Many concurrent writers to the same session must not lose updates.
      await Promise.all(Array.from({ length: 20 }, (_, i) =>
        store.append(batch('s1', [{ t: 2000 + i, type: 'click', data: {} }], { seq: i + 1 }))))
      await store.append(batch('s1', [
        { t: 5000, type: 'identify', data: { id: 'ada', traits: { plan: 'pro' } } },
        { t: 6000, type: 'nav', data: { href: 'https://shop.test/cart' } }
      ]))
      const meta = await store.getMeta('shop', 's1')
      assert.equal(meta.eventCount, 25)
      assert.equal(meta.startedAt, 1000)
      assert.equal(meta.lastEventAt, 6000)
      assert.equal(meta.errorCount, 1)
      assert.equal(meta.failedRequests, 1)
      assert.equal(meta.slowRequests, 1)
      assert.equal(meta.pageCount, 1)
      assert.equal(meta.firstUrl, 'https://shop.test/')
      assert.equal(meta.lastUrl, 'https://shop.test/cart')
      assert.equal(meta.userAgent, 'UA')
      assert.deepEqual(meta.viewport, { width: 800, height: 600 })
      assert.deepEqual(meta.user, { id: 'ada', traits: { plan: 'pro' } })
      assert.ok(meta.sizeBytes > 0)
    })

    test('returns events in ingest order', async () => {
      const events = await store.getEvents('shop', 's1')
      assert.equal(events.length, 25)
      assert.equal(events[0].type, 'meta')
      assert.equal(events[events.length - 1].type, 'nav')
      assert.equal(await store.getEvents('shop', 'nope'), null)
    })

    test('lists, filters and searches', async () => {
      await store.append(batch('s2', [{ t: 9000, type: 'meta', data: { href: 'https://shop.test/about' } }]))
      await store.append(Object.assign(batch('s3', [{ t: 100, type: 'meta', data: { href: 'https://blog.test/' } }]), { appId: 'blog' }))
      assert.deepEqual(await store.apps(), [{ appId: 'blog', sessions: 1 }, { appId: 'shop', sessions: 2 }])
      const all = await store.list({ appId: 'shop' })
      assert.equal(all.total, 2)
      assert.deepEqual(all.sessions.map(s => s.sessionId), ['s2', 's1']) // most recent first
      assert.deepEqual((await store.list({ errorsOnly: true })).sessions.map(s => s.sessionId), ['s1'])
      assert.deepEqual((await store.list({ q: 'ADA' })).sessions.map(s => s.sessionId), ['s1'])
      assert.deepEqual((await store.list({ q: 'about' })).sessions.map(s => s.sessionId), ['s2'])
      assert.equal((await store.list({ q: '100%_' })).total, 0) // LIKE wildcards are literal
      const paged = await store.list({ limit: 1, offset: 1 })
      assert.equal(paged.total, 3)
      assert.equal(paged.sessions.length, 1)
      assert.equal(await store.count(), 3)
    })

    test('stores assets and per-session asset maps', async () => {
      assert.equal(await store.hasAsset(HASH_A), false)
      await store.putAsset(HASH_A, 'image/png', Buffer.from('png-bytes'))
      await store.putAsset(HASH_A, 'image/png', Buffer.from('png-bytes')) // idempotent
      await store.putAsset(HASH_B, 'text/css; charset=utf-8', Buffer.from('a{}'))
      assert.equal(await store.hasAsset(HASH_A), true)
      const asset = await store.getAsset(HASH_A)
      assert.equal(asset.contentType, 'image/png')
      assert.equal(asset.body.toString(), 'png-bytes')
      assert.equal(await store.getAsset('c'.repeat(64)), null)

      await store.addSessionAssets('shop', 's1', { 'https://shop.test/a.png': HASH_A })
      await store.addSessionAssets('shop', 's1', { 'https://shop.test/b.css': HASH_B })
      assert.deepEqual(await store.getSessionAssets('shop', 's1'), {
        'https://shop.test/a.png': HASH_A,
        'https://shop.test/b.css': HASH_B
      })
      await store.addSessionAssets('shop', 'deleted-or-missing', { 'https://x/': HASH_A }) // must not throw
    })

    test('deletes sessions with their data, and garbage-collects assets', async () => {
      assert.equal(await store.delete('shop', 's1'), true)
      assert.equal(await store.delete('shop', 's1'), false)
      assert.equal(await store.getMeta('shop', 's1'), null)
      assert.equal(await store.getEvents('shop', 's1'), null)
      assert.deepEqual(await store.getSessionAssets('shop', 's1'), {})

      await store.addSessionAssets('shop', 's2', { 'https://shop.test/b.css': HASH_B })
      assert.equal(await store.gcAssets(0), 1) // A is no longer referenced, B still is
      assert.equal(await store.hasAsset(HASH_A), false)
      assert.equal(await store.hasAsset(HASH_B), true)
    })

    test('prunes old sessions', async () => {
      // s3 (t=100) and s2 (t=9000) are both ancient relative to now.
      assert.equal(await store.prune(1000), 2)
      assert.equal(await store.count(), 0)
    })
  })
}

let tmpDir
contract('FileStore', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logit-store-'))
  return new FileStore(tmpDir)
})
after(() => tmpDir && fs.rmSync(tmpDir, { recursive: true, force: true }))

let pg
const pgReady = startPostgres().then(p => { pg = p }, () => { pg = null })
after(async () => { if (pg) await pg.stop() })

describe('PgStore', async () => {
  await pgReady
  if (!pg) {
    test('Postgres unavailable', { skip: 'no LOGIT_TEST_DATABASE_URL and no local initdb/pg_ctl' }, () => {})
    return
  }
  const { PgStore } = require('../server/pg-store')

  contract('contract', async () => new PgStore(pg.url))

  test('two instances share one database without losing writes', async () => {
    const a = new PgStore(pg.url)
    const b = new PgStore(pg.url)
    await Promise.all([a.init(), b.init()]) // concurrent schema migration
    try {
      await Promise.all(Array.from({ length: 30 }, (_, i) =>
        (i % 2 ? a : b).append(batch('shared', [{ t: 10 + i, type: 'error', data: {} }], { seq: i }))))
      const metaFromB = await b.getMeta('shop', 'shared')
      assert.equal(metaFromB.eventCount, 30)
      assert.equal(metaFromB.errorCount, 30)
      assert.equal((await a.getEvents('shop', 'shared')).length, 30)
      await a.delete('shop', 'shared')
    } finally {
      await a.close()
      await b.close()
    }
  })

  test('two servers behind a load balancer see the same sessions', async () => {
    const opts = { port: 0, host: '127.0.0.1', databaseUrl: pg.url, adminToken: 't', retentionDays: 0, rateLimitPerMinute: 0, archiveAssets: false, log: () => {} }
    const one = await createApp(opts)
    const two = await createApp(opts)
    try {
      const ingest = await fetch(one.url + '/api/ingest', {
        method: 'POST',
        body: JSON.stringify(batch('lb', [{ t: 1, type: 'meta', data: { href: 'https://shop.test/' } }]))
      })
      assert.equal(ingest.status, 202)
      const res = await fetch(two.url + '/api/sessions/shop/lb', { headers: { Authorization: 'Bearer t' } })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.meta.firstUrl, 'https://shop.test/')
      assert.equal(body.events.length, 1)
      const health = await (await fetch(two.url + '/healthz')).json()
      assert.equal(health.ok, true)
    } finally {
      await one.close()
      await two.close()
    }
  })
})
