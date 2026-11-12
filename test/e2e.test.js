'use strict'

// Records a real session on the demo page in headless Chrome, then replays it in the viewer.
// Skipped when no Chrome/Chromium is installed (set CHROME_PATH to point at one).

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createApp } = require('../server')
const { findChrome, launch } = require('./helpers/chrome')

const chromePath = findChrome()
const TOKEN = 'e2e-token'
let app
let browser
let dataDir
let sessionId
let session

before(async () => {
  if (!chromePath) return
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logit-e2e-'))
  app = await createApp({
    port: 0, host: '127.0.0.1', dataDir, adminToken: TOKEN, allowedOrigins: ['*'], allowedAppIds: [],
    rateLimitPerMinute: 0, retentionDays: 0, serveDemo: true, log: () => {}
  })
  browser = await launch(chromePath)
})

after(async () => {
  if (browser) await browser.close()
  if (app) await app.close()
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
})

test('records a session on the demo page', { skip: !chromePath && 'Chrome not found' }, async () => {
  await browser.goto(app.url + '/demo/')
  await browser.waitFor('window.LogIt && LogIt.isRecording()')
  sessionId = await browser.evaluate('LogIt.getSessionId()')
  assert.ok(sessionId)

  // DOM mutations: add two todos, delete the first one.
  await browser.evaluate("document.getElementById('todo-input').focus()")
  await browser.type('Buy milk')
  await browser.evaluate("document.querySelector('#todo-form button').click()")
  await browser.evaluate("document.getElementById('todo-input').focus()")
  await browser.type('Ship LogIt')
  await browser.evaluate("document.querySelector('#todo-form button').click()")
  await browser.evaluate("document.querySelector('#todo-list li button').click()")

  // Inputs: the password must never leave the browser.
  await browser.evaluate("document.getElementById('email').focus()")
  await browser.type('ada@example.com')
  await browser.evaluate("document.getElementById('password').focus()")
  await browser.type('hunter2-secret')
  await browser.evaluate("document.getElementById('remember').click()")

  // A real mouse click, network, console, errors, custom events, SPA navigation.
  const pos = await browser.evaluate("(() => { const r = document.getElementById('fetch-ok').getBoundingClientRect(); return { x: r.x + 5, y: r.y + 5 } })()")
  await browser.click(pos.x, pos.y)
  await browser.waitFor("document.getElementById('status').textContent.includes('ok')")
  await browser.evaluate("document.getElementById('xhr-ok').click()")
  await browser.waitFor("document.getElementById('status').textContent.startsWith('XHR')")
  await browser.evaluate("fetch('/demo/missing.json')")
  await browser.evaluate("document.getElementById('log-error').click()")
  await browser.evaluate("document.getElementById('throw').click()")
  await browser.evaluate("document.getElementById('reject').click()")
  await browser.evaluate("document.getElementById('track').click()")
  await browser.evaluate("document.querySelector('#login-form button').click()")
  await browser.evaluate("document.getElementById('nav-b').click()")
  await browser.evaluate('new Promise(r => setTimeout(r, 400))')

  await browser.evaluate('LogIt.flush()')

  const res = await fetch(`${app.url}/api/sessions/demo/${sessionId}`, { headers: { Authorization: 'Bearer ' + TOKEN } })
  assert.equal(res.status, 200)
  session = await res.json()
})

test('captured every kind of event', { skip: !chromePath && 'Chrome not found' }, () => {
  const { events, meta } = session
  const ofType = type => events.filter(e => e.type === type)

  assert.ok(ofType('snapshot').length >= 1, 'snapshot')
  assert.ok(ofType('meta').length === 1, 'meta')
  assert.ok(ofType('mutation').some(e => (e.data.adds || []).length), 'mutation adds')
  assert.ok(ofType('mutation').some(e => (e.data.removes || []).length), 'mutation removes')
  assert.ok(ofType('click').some(e => e.data.selector === 'button#fetch-ok'), 'click')

  const network = ofType('network')
  assert.ok(network.some(e => e.data.kind === 'fetch' && e.data.url.endsWith('/healthz') && e.data.status === 200 && e.data.responseBody.includes('"ok"')), 'fetch 200')
  assert.ok(network.some(e => e.data.kind === 'xhr' && e.data.status === 200), 'xhr')
  assert.ok(network.some(e => e.data.status === 404), 'fetch 404')
  assert.ok(!network.some(e => e.data.url.includes('/api/ingest')), 'own traffic is not recorded')
  const login = network.find(e => e.data.method === 'POST')
  assert.equal(login.data.requestHeaders.Authorization, '[redacted]')

  assert.ok(ofType('console').some(e => e.data.level === 'error' && e.data.args[0].includes('Payment provider')), 'console.error')
  const errors = ofType('error')
  assert.ok(errors.some(e => e.data.kind === 'uncaught' && /price/.test(e.data.message)), 'uncaught error')
  assert.ok(errors.some(e => e.data.kind === 'unhandledrejection' && /timed out/.test(e.data.message)), 'unhandled rejection')
  assert.ok(ofType('custom').some(e => e.data.name === 'Checkout Started'), 'track')
  assert.ok(ofType('identify').some(e => e.data.id === 'ada@example.com'), 'identify')
  assert.ok(ofType('nav').some(e => e.data.href.endsWith('?page=cart')), 'pushState')
  assert.ok(ofType('perf').length >= 1, 'perf')

  assert.equal(meta.user.id, 'ada@example.com')
  assert.ok(meta.errorCount >= 3)
})

test('masks and blocks sensitive content', { skip: !chromePath && 'Chrome not found' }, () => {
  const raw = JSON.stringify(session.events)
  assert.ok(!raw.includes('hunter2-secret'), 'password leaked')
  assert.ok(!raw.includes('4111 1111'), 'masked text leaked')
  assert.ok(!raw.includes('never leaves the browser'), 'blocked element leaked')
  assert.ok(session.events.some(e => e.type === 'input' && e.data.value === '*'.repeat('hunter2-secret'.length)))
  assert.ok(session.events.some(e => e.type === 'input' && e.data.value === 'ada@example.com'))
})

test('replays the session in the viewer', { skip: !chromePath && 'Chrome not found' }, async () => {
  await browser.goto(app.url + '/viewer/')
  await browser.evaluate(`localStorage.setItem('logit_token', ${JSON.stringify(TOKEN)})`)
  await browser.goto(`${app.url}/viewer/?replay=1#/session/demo/${sessionId}`)
  await browser.waitFor('window.logitViewer && window.logitViewer.replayer')

  // Seek to the end: final DOM state must match what the user left behind.
  const end = await browser.evaluate(`(() => {
    const r = window.logitViewer.replayer
    r.seek(r.duration)
    const doc = r.getDocument()
    return {
      todos: [...doc.querySelectorAll('#todo-list li span')].map(s => s.textContent.trim()),
      email: doc.getElementById('email').value,
      password: doc.getElementById('password').value,
      remember: doc.getElementById('remember').checked,
      status: doc.getElementById('status').textContent,
      scripts: [...doc.scripts].every(s => s.type === 'text/logit-disabled'),
      blocked: doc.querySelector('[data-logit-blocked]').textContent,
      title: doc.title
    }
  })()`)
  assert.deepEqual(end.todos, ['Ship LogIt'])
  assert.equal(end.email, 'ada@example.com')
  assert.equal(end.password, '*'.repeat('hunter2-secret'.length))
  assert.equal(end.remember, true)
  assert.match(end.status, /XHR 200/)
  assert.equal(end.scripts, true)
  assert.equal(end.blocked, '')
  assert.equal(end.title, 'LogIt Demo Shop')

  // Seek back to the start: no todos yet.
  const start = await browser.evaluate(`(() => {
    const r = window.logitViewer.replayer
    r.seek(0)
    return r.getDocument().querySelectorAll('#todo-list li').length
  })()`)
  assert.equal(start, 0)

  // Devtools panel lists the network requests.
  await browser.evaluate("[...document.querySelectorAll('#tabs button')].find(b => b.textContent.startsWith('Network')).click()")
  const rows = await browser.evaluate("document.querySelectorAll('#panel .row').length")
  assert.ok(rows >= 4)
})
