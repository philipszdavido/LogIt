'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { AssetArchiver, extractAssetUrls, isPrivateAddress } = require('../server/assets')
const { FileStore } = require('../server/store')
const { createApp } = require('../server')

let origin
let site
let dataDir
let store

// A fake customer site serving the kinds of assets a page references.
const FILES = {
  '/style.css': ['text/css', '@import "other.css";\nbody{background:url(img/bg.png)}\n@font-face{src:url("/fonts/a.woff2")}\n.x{background:url(data:image/png;base64,AA==)}\n.y{background:url(/missing.png)}'],
  '/other.css': ['text/css', '.other{color:red}'],
  '/img/bg.png': ['image/png', 'PNGDATA'],
  '/fonts/a.woff2': ['application/octet-stream', 'WOFF2DATA'],
  '/page.html': ['text/html', '<script>alert(1)</script>'],
  '/app.js': ['application/javascript', 'alert(1)'],
  '/big.png': ['image/png', 'x'.repeat(5000)],
  '/icon.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>']
}

before(async () => {
  site = http.createServer((req, res) => {
    if (req.url === '/redirect.png') {
      res.writeHead(302, { Location: '/img/bg.png' })
      return res.end()
    }
    const file = FILES[req.url]
    if (!file) {
      res.writeHead(404)
      return res.end()
    }
    res.writeHead(200, { 'Content-Type': file[0] })
    res.end(file[1])
  })
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${site.address().port}`
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logit-assets-'))
  store = new FileStore(dataDir)
  await store.init()
})

after(async () => {
  site.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function archiver(opts = {}) {
  return new AssetArchiver(store, Object.assign({ allowPrivate: true, maxBytes: 1000 }, opts))
}

test('classifies private and public addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip)
  }
})

test('extracts asset URLs from every event type', () => {
  const urls = extractAssetUrls([
    {
      t: 1,
      type: 'snapshot',
      data: {
        node: {
          id: 1, type: 9, adopted: [{ id: 1, css: '.a{background:url(https://cdn.test/adopted.png)}' }],
          childNodes: [{
            id: 2, type: 1, tag: 'html', attrs: {}, childNodes: [
              { id: 3, type: 1, tag: 'img', attrs: { src: 'https://cdn.test/a.png', srcset: 'https://cdn.test/a2.png 2x, https://cdn.test/a3.png 3x' }, childNodes: [] },
              { id: 4, type: 1, tag: 'link', attrs: { rel: 'stylesheet', href: 'https://cdn.test/remote.css' }, childNodes: [] },
              { id: 5, type: 1, tag: 'link', attrs: { rel: 'stylesheet', href: 'https://cdn.test/inlined.css' }, cssText: 'b{background:url(https://cdn.test/inline-bg.png)}', childNodes: [] },
              { id: 6, type: 1, tag: 'style', attrs: {}, childNodes: [{ id: 7, type: 3, text: '@import "https://cdn.test/imp.css"; p{background:url(https://cdn.test/p.png)}' }] },
              { id: 8, type: 1, tag: 'p', attrs: {}, childNodes: [{ id: 9, type: 3, text: 'url(https://cdn.test/not-css.png)' }] },
              { id: 10, type: 1, tag: 'script', attrs: { src: 'https://cdn.test/app.js' }, childNodes: [] },
              { id: 11, type: 1, tag: 'div', attrs: { style: 'background:url(https://cdn.test/inline.png)' }, childNodes: [],
                shadow: { id: 12, type: 11, childNodes: [{ id: 13, type: 1, tag: 'img', attrs: { src: 'https://cdn.test/shadow.png' }, childNodes: [] }] } },
              { id: 14, type: 1, tag: 'iframe', attrs: {}, childNodes: [],
                doc: { id: 15, type: 9, childNodes: [{ id: 16, type: 1, tag: 'img', attrs: { src: 'https://cdn.test/frame.png' }, childNodes: [] }] } }
            ]
          }]
        }
      }
    },
    { t: 2, type: 'mutation', data: { attrs: [{ id: 3, attrs: { src: 'https://cdn.test/changed.png' } }], adds: [{ parentId: 2, node: { id: 20, type: 1, tag: 'video', attrs: { poster: 'https://cdn.test/poster.jpg' }, childNodes: [] } }] } },
    { t: 3, type: 'style', data: { id: 6, rule: '.z{background:url(https://cdn.test/rule.png)}' } },
    { t: 4, type: 'adopted', data: { id: 1, sheets: [{ id: 2, css: '.w{background:url(https://cdn.test/adopted2.png)}' }] } }
  ])
  assert.deepEqual([...urls].sort(), [
    'adopted.png', 'a.png', 'a2.png', 'a3.png', 'remote.css', 'inline-bg.png', 'imp.css', 'p.png', 'inline.png',
    'shadow.png', 'frame.png', 'changed.png', 'poster.jpg', 'rule.png', 'adopted2.png'
  ].map(f => 'https://cdn.test/' + f).sort())
})

test('archives a stylesheet and rewrites its references to archived copies', async () => {
  const a = archiver()
  await a.enqueue('shop', 'sess', [{ t: 1, type: 'style', data: { id: 1, css: `body{background:url(${origin}/style.css)}` } }])
  // Session not in the store index (not ingested here), so register it the way ingest would.
  await store.append({ appId: 'shop', sessionId: 'sess2', pageId: 'p', events: [{ t: 1, type: 'meta', data: {} }] })
  await a.enqueue('shop', 'sess2', [{ t: 1, type: 'snapshot', data: { node: { id: 1, type: 1, tag: 'link', attrs: { rel: 'stylesheet', href: origin + '/style.css' }, childNodes: [] } } }])

  const map = await store.getSessionAssets('shop', 'sess2')
  const cssHash = map[origin + '/style.css']
  assert.match(cssHash, /^[a-f0-9]{64}$/)
  const css = await store.getAsset(cssHash)
  assert.equal(css.contentType, 'text/css; charset=utf-8')
  const text = css.body.toString()
  assert.match(text, /@import "\/assets\/[a-f0-9]{64}"/)
  assert.match(text, /url\(\/assets\/[a-f0-9]{64}\)/)          // img/bg.png
  assert.match(text, /url\("\/assets\/[a-f0-9]{64}"\)/)        // font
  assert.match(text, /url\(data:image\/png;base64,AA==\)/)     // data: untouched
  assert.ok(text.includes(`url(${origin}/missing.png)`))       // failed fetch -> absolute original URL

  const fontHash = text.match(/url\("\/assets\/([a-f0-9]{64})"\)/)[1]
  const font = await store.getAsset(fontHash)
  assert.equal(font.contentType, 'font/woff2')                 // octet-stream sniffed from the extension
  assert.equal(font.body.toString(), 'WOFF2DATA')
})

test('refuses scripts, HTML, oversized files and follows redirects', async () => {
  const a = archiver()
  await assert.rejects(a.fetchAsset(origin + '/page.html'), /not an archivable type/)
  await assert.rejects(a.fetchAsset(origin + '/app.js'), /not an archivable type/)
  await assert.rejects(a.fetchAsset(origin + '/big.png'), /too large/)
  await assert.rejects(a.fetchAsset('file:///etc/passwd'), /unsupported protocol/)
  const redirected = await a.fetchAsset(origin + '/redirect.png')
  assert.equal(redirected.body.toString(), 'PNGDATA')
})

test('blocks private network addresses unless allowed (SSRF guard)', async () => {
  const a = archiver({ allowPrivate: false })
  await assert.rejects(a.fetchAsset(origin + '/img/bg.png'), err => err.code === 'EPRIVATE')
  await assert.rejects(a.fetchAsset('http://localhost:1/x.png'), err => err.code === 'EPRIVATE')
  await assert.rejects(a.fetchAsset('http://169.254.169.254/latest/meta-data/'), err => err.code === 'EPRIVATE')
  await assert.rejects(a.fetchAsset('http://[::1]:1/x.png'), err => err.code === 'EPRIVATE')
  assert.equal(await a.archive(origin + '/img/bg.png', 0), null)
})

test('restricts archiving to allowed hosts', async () => {
  const a = archiver({ allowedHosts: ['cdn.example.com'] })
  await assert.rejects(a.fetchAsset(origin + '/img/bg.png'), /LOGIT_ASSET_HOSTS/)
})

test('server archives assets on ingest and serves them safely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logit-assets-app-'))
  const app = await createApp({
    port: 0, host: '127.0.0.1', dataDir: dir, adminToken: '', retentionDays: 0, rateLimitPerMinute: 0,
    archiveAssets: true, assetAllowPrivate: true, log: () => {}
  })
  try {
    const ingest = await fetch(app.url + '/api/ingest', {
      method: 'POST',
      body: JSON.stringify({
        appId: 'shop', sessionId: 'withassets', pageId: 'p', events: [{
          t: 1, type: 'snapshot', data: { node: { id: 1, type: 9, childNodes: [
            { id: 2, type: 1, tag: 'img', attrs: { src: origin + '/icon.svg' }, childNodes: [] }
          ] } }
        }]
      })
    })
    assert.equal(ingest.status, 202)
    await app.archiver.drain()

    const session = await (await fetch(app.url + '/api/sessions/shop/withassets')).json()
    const hash = session.assets[origin + '/icon.svg']
    assert.match(hash, /^[a-f0-9]{64}$/)

    const asset = await fetch(app.url + '/assets/' + hash)
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('content-type'), 'image/svg+xml')
    assert.match(asset.headers.get('content-security-policy'), /sandbox/)
    assert.match(asset.headers.get('cache-control'), /immutable/)
    assert.equal(await asset.text(), FILES['/icon.svg'][1])

    assert.equal((await fetch(app.url + '/assets/' + 'f'.repeat(64))).status, 404)
    assert.equal((await fetch(app.url + '/assets/..%2F..%2Fpackage.json')).status, 404)
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
