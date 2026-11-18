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
let remote

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

  // Shadow DOM: an open root, then Tab from it into the closed root's input (unreachable from page JS).
  await browser.evaluate("document.getElementById('counter').shadowRoot.querySelector('button').click()")
  await browser.evaluate("document.getElementById('counter').shadowRoot.querySelector('button').click()")
  await browser.evaluate("document.getElementById('counter').shadowRoot.querySelector('button').focus()")
  await browser.press('Tab', 'Tab', 9)
  await browser.type('closed-root-text')

  // Same-origin iframe.
  await browser.waitFor("document.getElementById('widget').contentDocument.getElementById('frame-add')")
  await browser.evaluate("document.getElementById('widget').contentDocument.getElementById('frame-add').click()")
  await browser.evaluate("document.getElementById('widget').contentDocument.getElementById('frame-add').click()")
  await browser.evaluate("document.getElementById('widget').contentDocument.getElementById('frame-input').focus()")
  await browser.type('typed in iframe')

  // Cross-origin iframe (localhost vs 127.0.0.1): page JS can't reach in, so use real input events.
  await browser.waitFor("performance.getEntriesByType('resource').some(e => e.initiatorType === 'iframe' && e.name.includes('remote.html'))")
  await browser.evaluate('new Promise(r => setTimeout(r, 500))') // handshake + the frame's snapshot
  remote = await browser.evaluate(`(() => {
    const f = document.getElementById('remote')
    f.scrollIntoView({ block: 'center' })
    const r = f.getBoundingClientRect()
    return { x: r.x + f.clientLeft, y: r.y + f.clientTop }
  })()`)
  await browser.evaluate('new Promise(r => setTimeout(r, 200))')
  await browser.click(remote.x + 20, remote.y + 20) // #remote-add
  await browser.click(remote.x + 20, remote.y + 55) // #remote-input
  await browser.type('cross-origin text')

  // A cross-origin iframe without LogIt, and an HLS stream played through MediaSource.
  await browser.waitFor("performance.getEntriesByType('resource').some(e => e.initiatorType === 'iframe' && e.name.includes('static-widget.html'))")
  assert.equal(await browser.evaluate('window.hlsReady'), true, 'demo HLS player ran')

  // adoptedStyleSheets changed in place.
  await browser.evaluate("document.getElementById('theme').click()")

  // Media + canvas: play the stream-backed video and let a few canvas frames be sampled.
  await browser.evaluate("document.getElementById('video-toggle').click()")
  await browser.evaluate('new Promise(r => setTimeout(r, 1200))')

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

test('captured shadow DOM, iframes, canvas, media and stylesheets', { skip: !chromePath && 'Chrome not found' }, () => {
  const { events } = session
  const ofType = type => events.filter(e => e.type === type)
  const snapshots = JSON.stringify(ofType('snapshot'))

  assert.ok(snapshots.includes('"shadow"'), 'shadow roots serialized')
  assert.ok(snapshots.includes('"adopted"'), 'adopted stylesheets serialized')
  assert.ok(snapshots.includes('"doc"') || ofType('iframe').length, 'iframe document serialized')
  assert.ok(snapshots.includes('pattern.svg'), 'linked stylesheet inlined')
  assert.ok(ofType('input').some(e => e.data.value === 'closed-root-text'), 'input inside closed shadow root')
  assert.ok(ofType('input').some(e => e.data.value === 'typed in iframe'), 'input inside iframe')
  assert.ok(ofType('canvas').length >= 1, 'canvas frames')
  assert.ok(ofType('canvas').every(e => e.data.data.startsWith('data:image/')), 'frames are images')
  assert.ok(ofType('media').some(e => e.data.action === 'play'), 'media play event')
  assert.ok(ofType('iframe').some(e => e.data.node && JSON.stringify(e.data.node).includes('remote-list')), 'cross-origin iframe snapshot')
  assert.ok(ofType('input').some(e => e.data.value === 'cross-origin text'), 'input inside cross-origin iframe')
  const remoteClick = ofType('click').find(e => e.data.selector === 'button#remote-add')
  assert.ok(remoteClick && Math.abs(remoteClick.data.x - (remote.x + 20)) <= 2, 'click position mapped to the top page')
  assert.ok(ofType('iframe').some(e => (e.data.url || '').endsWith('/demo/static-widget.html')), 'iframe without LogIt recorded by URL')
  assert.ok(ofType('stream').some(e => e.data.url === app.url + '/demo/stream/master.m3u8'), 'HLS manifest matched to its <video>')
  assert.ok(ofType('adopted').some(e => e.data.id === 1 && e.data.sheets.some(s => (s.css || '').includes('rgb(22, 163, 74)'))), 'in-place adoptedStyleSheets change')
})

test('archived the page assets on the server', { skip: !chromePath && 'Chrome not found' }, async () => {
  await app.archiver.drain()
  // The server reports the login-protected avatar as missing in an ingest response; the SDK uploads it.
  await browser.evaluate("LogIt.track('poke'); LogIt.flush()")
  const res = await fetch(`${app.url}/api/sessions/demo/${sessionId}`, { headers: { Authorization: 'Bearer ' + TOKEN } })
  const { assets } = await res.json()
  const hash = assets[app.url + '/demo/pattern.svg']
  assert.match(hash || '', /^[a-f0-9]{64}$/)
  const asset = await fetch(app.url + '/assets/' + hash)
  assert.equal(asset.headers.get('content-type'), 'image/svg+xml')

  const avatar = await fetch(app.url + '/assets/' + assets[app.url + '/demo/private/avatar.svg'])
  assert.equal(avatar.status, 200, 'asset behind a login uploaded by the SDK')
  assert.match(await avatar.text(), /#7c3aed/)

  // The HLS stream, flattened into one fragmented MP4: init segment + media segments.
  const stream = await fetch(app.url + '/assets/' + assets[app.url + '/demo/stream/master.m3u8'])
  assert.equal(stream.headers.get('content-type'), 'video/mp4')
  const expected = Buffer.concat(['init.mp4', 'seg0.m4s', 'seg1.m4s'].map(f => fs.readFileSync(path.join(__dirname, '..', 'demo', 'stream', f))))
  assert.ok(Buffer.from(await stream.arrayBuffer()).equals(expected), 'flattened stream')

  // The third-party iframe's HTML, plus the image it uses.
  const staticUrl = app.url.replace('127.0.0.1', 'localhost') + '/demo/static-widget.html'
  assert.match(assets['frame:' + staticUrl] || '', /^[a-f0-9]{64}$/, 'iframe HTML archived')
  assert.match(assets[app.url.replace('127.0.0.1', 'localhost') + '/demo/pattern.svg'] || '', /^[a-f0-9]{64}$/, 'iframe image archived')

  const audio = await fetch(app.url + '/assets/' + assets[app.url + '/demo/tone.wav'], { headers: { Range: 'bytes=0-3' } })
  assert.equal(audio.status, 206, 'audio archived and served with ranges')
  assert.equal(audio.headers.get('content-type'), 'audio/wav')
  assert.equal(await audio.text(), 'RIFF')
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

  // Shadow DOM, constructed stylesheets, iframes, canvas, video and archived assets.
  const rich = await browser.evaluate(`(() => {
    const doc = window.logitViewer.replayer.getDocument()
    const counter = doc.getElementById('counter').shadowRoot
    const secret = doc.getElementById('secret-field').shadowRoot
    const frameDoc = doc.getElementById('widget').contentDocument
    return {
      count: counter.querySelector('span').textContent,
      counterColor: doc.defaultView.getComputedStyle(counter.querySelector('button')).backgroundColor,
      secretValue: secret.querySelector('input').value,
      frameRows: frameDoc.querySelectorAll('#frame-list li').length,
      frameInput: frameDoc.getElementById('frame-input').value,
      poster: (doc.getElementById('video').getAttribute('poster') || '').slice(0, 11),
      heroBackground: doc.defaultView.getComputedStyle(doc.querySelector('.hero')).backgroundImage,
      linkedStylesheets: doc.querySelectorAll('link[rel=stylesheet]').length,
      themeBorder: doc.defaultView.getComputedStyle(doc.querySelector('.hero')).borderLeftColor,
      remoteRows: [...doc.getElementById('remote').contentDocument.querySelectorAll('#remote-list li')].map(li => li.textContent),
      remoteInput: doc.getElementById('remote').contentDocument.getElementById('remote-input').value,
      avatar: doc.getElementById('avatar').getAttribute('src'),
      staticTitle: doc.getElementById('static').contentDocument.getElementById('static-title').textContent,
      staticImg: doc.getElementById('static').contentDocument.getElementById('static-img').getAttribute('src'),
      staticScripts: doc.getElementById('static').contentDocument.scripts.length,
      hls: doc.getElementById('hls').getAttribute('src'),
      audio: doc.getElementById('audio').getAttribute('src')
    }
  })()`)
  assert.equal(rich.count, '2')
  assert.equal(rich.counterColor, 'rgb(190, 24, 93)')
  assert.equal(rich.secretValue, 'closed-root-text')
  assert.equal(rich.frameRows, 2)
  assert.equal(rich.frameInput, 'typed in iframe')
  assert.equal(rich.poster, 'data:image/')
  assert.equal(rich.linkedStylesheets, 0)
  assert.match(rich.heroBackground, /\/assets\/[a-f0-9]{64}/)
  assert.equal(rich.themeBorder, 'rgb(22, 163, 74)')
  assert.deepEqual(rich.remoteRows, ['Remote row 1'])
  assert.equal(rich.remoteInput, 'cross-origin text')
  assert.match(rich.avatar, /^\/assets\/[a-f0-9]{64}$/)
  assert.match(rich.audio, /^\/assets\/[a-f0-9]{64}$/)
  assert.equal(rich.staticTitle, 'Third-party widget (no LogIt)')
  assert.match(rich.staticImg, /^\/assets\/[a-f0-9]{64}$/)
  assert.equal(rich.staticScripts, 0)
  assert.match(rich.hls, /^\/assets\/[a-f0-9]{64}$/)
  // The flattened stream really decodes in the replay.
  await browser.waitFor("window.logitViewer.replayer.getDocument().getElementById('hls').readyState >= 1", 5000)

  // Canvas frames are decoded asynchronously.
  await browser.waitFor(`(() => {
    const c = window.logitViewer.replayer.getDocument().getElementById('canvas')
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] < 120 && px[i + 2] < 60) return true
    return false
  })()`, 5000)

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
