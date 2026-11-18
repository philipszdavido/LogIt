'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { AssetArchiver, extractAssetUrls, extractArchiveTargets, isPrivateAddress } = require('../server/assets')
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
  '/icon.svg': ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  '/clip.mp4': ['video/mp4', 'MP4DATA'.repeat(500)],
  '/clip.webm': ['application/octet-stream', 'WEBMDATA'],
  '/huge.mp4': ['video/mp4', 'x'.repeat(20000)],
  '/long.webm': ['video/webm', 'W'.repeat(20000)],
  '/faststart.mp4': ['video/mp4', Buffer.concat([box('ftyp', 8), box('moov', 92), box('mdat', 19992)])],
  '/tail.mp4': ['video/mp4', Buffer.concat([box('ftyp', 8), box('mdat', 19992), box('moov', 92)])],
  '/huge.wav': ['audio/wav', 'R'.repeat(20000)],
  '/token.png': ['image/png', 'TOKEN-PNG'],
  // windows-1252 page: 0xE9 is 'é'
  '/widget.html': ['text/html; charset=windows-1252', Buffer.concat([
    Buffer.from('<html><head><base href="/img/"><link rel="stylesheet" href="/other.css"></head><body>caf'),
    Buffer.from([0xe9]),
    Buffer.from('<img src="bg.png"><div style="background:url(&quot;/fonts/a.woff2&quot;)"></div></body></html>')
  ])],
  // HLS: a master playlist with two variants (the one under 2 Mbit/s is archived), byte ranges, live, MPEG-TS
  '/hls/master.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n'],
  '/hls/low.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\ns0.m4s\n#EXTINF:1,\ns1.m4s\n#EXT-X-ENDLIST\n'],
  '/hls/high.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nhigh.m4s\n#EXT-X-ENDLIST\n'],
  '/hls/init.mp4': ['video/mp4', 'INIT'],
  '/hls/s0.m4s': ['video/iso.segment', 'S0'],
  '/hls/s1.m4s': ['video/iso.segment', 'S1'],
  '/hls/br.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-MAP:URI="all.mp4",BYTERANGE="4@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:2@4\nall.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:2\nall.mp4\n#EXT-X-ENDLIST\n'],
  '/hls/all.mp4': ['video/mp4', 'INITAABBzz'],
  '/hls/live.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\ns0.m4s\n'],
  '/hls/ts.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXTINF:1,\ns0.ts\n#EXT-X-ENDLIST\n'],
  '/hls/long.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n' + [0, 1, 2, 3, 4].map(() => '#EXTINF:1,\nten.m4s\n').join('') + '#EXT-X-ENDLIST\n'],
  '/hls/ten.m4s': ['video/iso.segment', '0123456789'],
  // DASH: $Number$ templates (with an audio set that must be skipped), a SegmentTimeline with $Time$
  '/dash/number.mpd': ['application/dash+xml', `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT5S">
  <Period>
    <AdaptationSet contentType="audio" mimeType="audio/mp4"><Representation id="a1" bandwidth="64000"/></AdaptationSet>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$.m4s" startNumber="1" duration="2" timescale="1"/>
      <Representation id="v1" bandwidth="500000" width="640" height="360"/>
    </AdaptationSet>
  </Period>
</MPD>`],
  '/dash/v1/init.mp4': ['video/mp4', 'I'],
  '/dash/v1/seg-001.m4s': ['video/iso.segment', 'A'],
  '/dash/v1/seg-002.m4s': ['video/iso.segment', 'B'],
  '/dash/v1/seg-003.m4s': ['video/iso.segment', 'C'],
  '/dash/timeline.mpd': ['application/dash+xml', `<MPD type="static" mediaPresentationDuration="PT25S"><Period><BaseURL>t/</BaseURL>
    <AdaptationSet mimeType="video/webm"><Representation id="v" bandwidth="300000">
      <SegmentTemplate initialization="init.webm" media="$Time$.webm"><SegmentTimeline><S t="0" d="10" r="1"/><S d="5"/></SegmentTimeline></SegmentTemplate>
    </Representation></AdaptationSet></Period></MPD>`],
  '/dash/t/init.webm': ['video/webm', 'X'],
  '/dash/t/0.webm': ['video/webm', '1'],
  '/dash/t/10.webm': ['video/webm', '2'],
  '/dash/t/20.webm': ['video/webm', '3']
}

// An MP4 box of the given type and total size.
function box(type, size) {
  const b = Buffer.alloc(size)
  b.writeUInt32BE(size, 0)
  b.write(type, 4, 'latin1')
  return b
}

before(async () => {
  site = http.createServer((req, res) => {
    if (req.url === '/private.png') {
      res.writeHead(401) // behind a login
      return res.end()
    }
    if (req.url === '/token.png' && req.headers['x-token'] !== 'abc') {
      res.writeHead(401)
      return res.end()
    }
    if (req.url === '/redirect.png') {
      res.writeHead(302, { Location: '/img/bg.png' })
      return res.end()
    }
    const file = FILES[req.url]
    if (!file) {
      res.writeHead(404)
      return res.end()
    }
    const body = Buffer.from(file[1])
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '')
    if (range) {
      res.writeHead(206, { 'Content-Type': file[0], 'Content-Range': `bytes ${range[1]}-${range[2]}/${body.length}` })
      return res.end(body.subarray(Number(range[1]), Number(range[2]) + 1))
    }
    res.writeHead(200, { 'Content-Type': file[0] })
    res.end(body)
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
    { t: 2, type: 'mutation', data: { attrs: [{ id: 3, attrs: { src: 'https://cdn.test/changed.png' } }], adds: [{ parentId: 2, node: { id: 20, type: 1, tag: 'video', attrs: { poster: 'https://cdn.test/poster.jpg', src: 'https://cdn.test/movie.mp4' }, childNodes: [] } }] } },
    { t: 3, type: 'style', data: { id: 6, rule: '.z{background:url(https://cdn.test/rule.png)}' } },
    { t: 4, type: 'adopted', data: { id: 1, sheets: [{ id: 2, css: '.w{background:url(https://cdn.test/adopted2.png)}' }] } }
  ])
  assert.deepEqual([...urls].sort(), [
    'adopted.png', 'a.png', 'a2.png', 'a3.png', 'remote.css', 'inline-bg.png', 'imp.css', 'p.png', 'inline.png',
    'shadow.png', 'frame.png', 'changed.png', 'poster.jpg', 'movie.mp4', 'rule.png', 'adopted2.png'
  ].map(f => 'https://cdn.test/' + f).sort())
})

test('leaves media URLs out when media archiving is off', () => {
  const events = [{ t: 1, type: 'snapshot', data: { node: { id: 1, type: 1, tag: 'audio', attrs: { src: 'https://cdn.test/a.mp3' }, childNodes: [] } } }]
  assert.deepEqual([...extractAssetUrls(events)], ['https://cdn.test/a.mp3'])
  assert.deepEqual([...extractAssetUrls(events, { media: false })], [])
})

async function archived(a, url, kind) {
  const hash = await a.archive(url, 0, kind)
  if (!hash) return null
  const asset = await store.getAsset(hash)
  return { contentType: asset.contentType, text: asset.body.toString('latin1'), size: asset.body.length }
}

test('archives video and audio with their own size limit', async () => {
  const a = archiver({ mediaMaxBytes: 10000 })
  const mp4 = await archived(a, origin + '/clip.mp4')
  assert.equal(mp4.contentType, 'video/mp4')
  assert.equal(mp4.size, 3500)                                    // above maxBytes (1000), within mediaMaxBytes
  assert.equal((await archived(a, origin + '/clip.webm')).contentType, 'video/webm') // octet-stream, by extension
  assert.equal(await archived(a, origin + '/huge.mp4'), null)    // not a real MP4: can't be cut
  assert.equal(await archived(a, origin + '/huge.wav'), null)    // WAV can't be cut either
  await assert.rejects(archiver({ archiveMedia: false }).fetchAsset(origin + '/clip.mp4'), /not an archivable type/)
  await a.close()
})

test('keeps the playable beginning of media over the size limit', async () => {
  const a = archiver({ mediaMaxBytes: 10000 })
  assert.equal((await archived(a, origin + '/long.webm')).text, 'W'.repeat(10000))
  const mp4 = await archived(a, origin + '/faststart.mp4')       // moov before mdat: the prefix plays
  assert.equal(mp4.size, 10000)
  assert.equal(mp4.text, FILES['/faststart.mp4'][1].subarray(0, 10000).toString('latin1'))
  assert.equal(await archived(a, origin + '/tail.mp4'), null)    // moov at the end: the prefix is useless
  await a.close()
})

test('archives the HTML of cross-origin iframes and the assets it uses', async () => {
  const a = archiver()
  await store.append({ appId: 'shop', sessionId: 'frames', pageId: 'p', events: [{ t: 1, type: 'meta', data: {} }] })
  await a.enqueue('shop', 'frames', [{ t: 1, type: 'iframe', data: { id: 5, url: origin + '/widget.html' } }])
  const map = await store.getSessionAssets('shop', 'frames')
  const html = (await store.getAsset(map['frame:' + origin + '/widget.html'])).body.toString('utf8')
  assert.match(html, /café/)                                      // windows-1252 re-encoded as UTF-8
  assert.match(map[origin + '/img/bg.png'], /^[a-f0-9]{64}$/)     // <img>, resolved against <base href>
  assert.match(map[origin + '/other.css'], /^[a-f0-9]{64}$/)      // <link rel=stylesheet>
  assert.match(map[origin + '/fonts/a.woff2'], /^[a-f0-9]{64}$/)  // style attribute, entities decoded
  assert.equal(await archived(a, origin + '/img/bg.png', 'frame'), null) // only HTML counts as a frame
})

test('flattens HLS and DASH streams into one playable file', async () => {
  const a = archiver({ mediaMaxBytes: 25 })
  const hls = await archived(a, origin + '/hls/master.m3u8', 'stream')
  assert.deepEqual(hls, { contentType: 'video/mp4', text: 'INITS0S1', size: 8 }) // the 800 kbit/s variant
  assert.equal((await archived(a, origin + '/hls/br.m3u8', 'stream')).text, 'INITAABB')  // byte ranges
  assert.equal((await archived(a, origin + '/hls/long.m3u8', 'stream')).text, 'INIT' + '0123456789'.repeat(2)) // cut at 25 bytes
  assert.equal(await archived(a, origin + '/hls/live.m3u8', 'stream'), null)
  assert.equal(await archived(a, origin + '/hls/ts.m3u8', 'stream'), null)
  assert.deepEqual(await archived(a, origin + '/dash/number.mpd', 'stream'), { contentType: 'video/mp4', text: 'IABC', size: 4 })
  assert.deepEqual(await archived(a, origin + '/dash/timeline.mpd', 'stream'), { contentType: 'video/webm', text: 'X123', size: 4 })
  await a.close()
})

test('sends configured credentials only to their own host', async () => {
  assert.equal(await archived(archiver(), origin + '/token.png'), null)
  const scoped = archiver({ hostHeaders: { localhost: { 'x-token': 'abc' } } })
  assert.equal(await archived(scoped, origin + '/token.png'), null)  // 127.0.0.1 is not localhost
  const a = archiver({ hostHeaders: { '127.0.0.1': { 'x-token': 'abc' } } })
  assert.equal((await archived(a, origin + '/token.png')).text, 'TOKEN-PNG')
})

test('finds frames and streams in recorded events', () => {
  const { assets, frames, streams } = extractArchiveTargets([
    { t: 1, type: 'snapshot', data: { node: { id: 1, type: 9, childNodes: [
      { id: 2, type: 1, tag: 'iframe', remote: 1, attrs: { src: 'https://third.party/w' }, childNodes: [] },
      { id: 3, type: 1, tag: 'iframe', attrs: { src: 'https://same.origin/f' }, childNodes: [], doc: { id: 4, type: 9, childNodes: [] } },
      { id: 5, type: 1, tag: 'video', attrs: { src: 'https://cdn.test/native.m3u8' }, childNodes: [] },
      { id: 6, type: 1, tag: 'video', attrs: { src: 'blob:https://x/1' }, stream: 'https://cdn.test/mse.mpd', childNodes: [
        { id: 7, type: 1, tag: 'source', attrs: { src: 'https://cdn.test/play?id=1', type: 'application/x-mpegURL' }, childNodes: [] }
      ] }
    ] } } },
    { t: 2, type: 'iframe', data: { id: 2, url: 'https://third.party/next' } },
    { t: 3, type: 'stream', data: { id: 6, url: 'https://cdn.test/later.m3u8' } }
  ])
  assert.deepEqual([...frames].sort(), ['https://third.party/next', 'https://third.party/w'])
  assert.deepEqual([...streams].sort(), ['https://cdn.test/later.m3u8', 'https://cdn.test/mse.mpd', 'https://cdn.test/native.m3u8', 'https://cdn.test/play?id=1'])
  assert.deepEqual([...assets], [])
})

test('reports assets it could not fetch, and stores them when the SDK uploads them', async () => {
  const a = archiver()
  await store.append({ appId: 'shop', sessionId: 'auth', pageId: 'p', events: [{ t: 1, type: 'meta', data: {} }] })
  await a.enqueue('shop', 'auth', [{ t: 1, type: 'snapshot', data: { node: { id: 1, type: 1, tag: 'img', attrs: { src: origin + '/private.png' }, childNodes: [] } } }])
  assert.deepEqual(a.takeMissing('shop', 'auth'), [origin + '/private.png'])
  assert.deepEqual(a.takeMissing('shop', 'auth'), [])           // handed out once

  const hash = await a.storeUpload('shop', 'auth', origin + '/private.png', 'image/png', Buffer.from('SECRET-PNG'))
  assert.deepEqual(await store.getSessionAssets('shop', 'auth'), { [origin + '/private.png']: hash })
  assert.equal((await store.getAsset(hash)).body.toString(), 'SECRET-PNG')
  await assert.rejects(a.storeUpload('shop', 'auth', origin + '/x', 'text/html', Buffer.from('<p>')), err => err.status === 415)
  await assert.rejects(a.storeUpload('shop', 'auth', origin + '/x.png', 'image/png', Buffer.alloc(2000)), err => err.status === 413)
  await assert.rejects(a.storeUpload('shop', 'auth', 'javascript:alert(1)', 'image/png', Buffer.from('x')), err => err.status === 400)
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

test('server asks the SDK for assets it could not fetch and accepts uploads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logit-assets-upload-'))
  const app = await createApp({
    port: 0, host: '127.0.0.1', dataDir: dir, adminToken: '', retentionDays: 0, rateLimitPerMinute: 0,
    archiveAssets: true, assetAllowPrivate: true, assetMaxBytes: 1000, allowedOrigins: ['https://shop.test'], log: () => {}
  })
  const ingest = events => fetch(app.url + '/api/ingest', {
    method: 'POST', body: JSON.stringify({ appId: 'shop', sessionId: 'up', pageId: 'p', events })
  })
  const upload = (query, body, type = 'image/png', headers = {}) =>
    fetch(`${app.url}/api/assets?${query}`, { method: 'POST', body, headers: Object.assign({ 'Content-Type': type }, headers) })
  try {
    assert.equal((await (await ingest([{ t: 1, type: 'snapshot', data: { node: { id: 1, type: 1, tag: 'img', attrs: { src: origin + '/private.png' }, childNodes: [] } } }])).json()).missing, undefined)
    await app.archiver.drain()
    const next = await (await ingest([{ t: 2, type: 'click', data: {} }])).json()
    assert.deepEqual(next.missing, [origin + '/private.png'])

    const url = encodeURIComponent(origin + '/private.png')
    const ok = await upload(`appId=shop&sessionId=up&url=${url}`, 'PRIVATE')
    assert.equal(ok.status, 201)
    const { hash } = await ok.json()
    const session = await (await fetch(app.url + '/api/sessions/shop/up')).json()
    assert.equal(session.assets[origin + '/private.png'], hash)

    assert.equal((await upload(`appId=shop&sessionId=nope&url=${url}`, 'x')).status, 404)
    assert.equal((await upload(`appId=shop&sessionId=up&url=${url}`, '<p>', 'text/html')).status, 415)
    assert.equal((await upload(`appId=shop&sessionId=up&url=${url}`, 'x'.repeat(2000))).status, 413)
    assert.equal((await upload(`appId=shop&sessionId=up&url=file%3A%2F%2F%2Fetc%2Fpasswd`, 'x')).status, 400)
    assert.equal((await upload(`appId=..&sessionId=up&url=${url}`, 'x')).status, 400)
    assert.equal((await upload(`appId=shop&sessionId=up&url=${url}`, 'x', 'image/png', { Origin: 'https://evil.test' })).status, 403)
    const preflight = await fetch(app.url + '/api/assets', { method: 'OPTIONS', headers: { Origin: 'https://shop.test' } })
    assert.equal(preflight.status, 204)
    assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/)
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
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
            { id: 2, type: 1, tag: 'img', attrs: { src: origin + '/icon.svg' }, childNodes: [] },
            { id: 3, type: 1, tag: 'iframe', remote: 1, attrs: { src: origin + '/page.html' }, childNodes: [] }
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

    // Archived iframe HTML is data for the replayer: never served as a page.
    const frame = await fetch(app.url + '/assets/' + session.assets['frame:' + origin + '/page.html'])
    assert.equal(frame.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.match(frame.headers.get('content-security-policy'), /sandbox/)
    assert.equal(await frame.text(), FILES['/page.html'][1])

    assert.equal((await fetch(app.url + '/assets/' + 'f'.repeat(64))).status, 404)
    assert.equal((await fetch(app.url + '/assets/..%2F..%2Fpackage.json')).status, 404)

    // Byte ranges, so replayed media can seek.
    const size = FILES['/icon.svg'][1].length
    const ranged = await fetch(app.url + '/assets/' + hash, { headers: { Range: 'bytes=1-4' } })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('content-range'), `bytes 1-4/${size}`)
    assert.equal(await ranged.text(), FILES['/icon.svg'][1].slice(1, 5))
    assert.equal(await (await fetch(app.url + '/assets/' + hash, { headers: { Range: 'bytes=-3' } })).text(), FILES['/icon.svg'][1].slice(-3))
    assert.equal((await fetch(app.url + '/assets/' + hash, { headers: { Range: `bytes=${size}-` } })).status, 416)
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
