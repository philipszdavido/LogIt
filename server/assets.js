'use strict'

// Archives what a recorded page references, so replays keep working after the site changes:
//   - images, fonts, stylesheets, video and audio (stored content-addressed, served from /assets/<sha256>)
//   - HLS / DASH streams, flattened into one playable file (fragmented MP4 / WebM)
//   - the HTML of cross-origin iframes that don't run LogIt, replayed as a static document
// Assets the server can't fetch (e.g. behind a login) are reported back to the SDK, which may upload them.

const http = require('http')
const https = require('https')
const dns = require('dns')
const net = require('net')
const fs = require('fs')
const fsp = fs.promises
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
const CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi
const STREAM_RE = /\.(m3u8|mpd)(?:[?#]|$)/i
const STREAM_TYPE_RE = /mpegurl|dash\+xml/i
const FONT_TYPES = { woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject' }
const MEDIA_TYPES = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', oga: 'audio/ogg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac'
}
// Formats whose first N bytes still play (headers first). MP4 only qualifies when 'moov' precedes 'mdat'.
const TRUNCATABLE_RE = /^(video\/(webm|ogg|mp4|quicktime)|audio\/(webm|ogg|mpeg|mp4|aac))$/
const MAX_URLS_PER_BATCH = 300
const MAX_CSS_DEPTH = 3
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_STREAM_SEGMENTS = 2000
const PREFERRED_STREAM_BANDWIDTH = 2000000
const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_MISSING_SESSIONS = 5000
const MAX_MISSING_PER_SESSION = 50

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) ||           // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase()
    const dotted = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (dotted) return isPrivateAddress(dotted[1])
    const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (hex) {
      const hi = parseInt(hex[1], 16)
      const lo = parseInt(hex[2], 16)
      return isPrivateAddress([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'))
    }
    return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff')
  }
  return true
}

// Validates every address at connect time, so DNS rebinding can't slip a private IP past a pre-check.
function guardedLookup(allowPrivate) {
  return function (hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    dns.lookup(hostname, { all: true, family: options.family || 0 }, (err, addresses) => {
      if (err) return callback(err)
      if (!allowPrivate) {
        const blocked = addresses.find(a => isPrivateAddress(a.address))
        if (blocked) return callback(Object.assign(new Error(`refusing private address ${blocked.address}`), { code: 'EPRIVATE' }))
      }
      if (options.all) return callback(null, addresses)
      callback(null, addresses[0].address, addresses[0].family)
    })
  }
}

function typeFromExtension(pathname, media) {
  const ext = (pathname.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1]
  return FONT_TYPES[ext] || (media && MEDIA_TYPES[ext]) || null
}

function isMediaType(type) {
  return /^(video|audio)\//.test(type)
}

// Only passive resources are archived as assets: never HTML or scripts.
function archivableType(type, pathname, media) {
  if (/^image\//.test(type) || /^font\//.test(type) || type === 'text/css') return type
  if (/^application\/(font-woff2?|x-font-[\w-]+|font-sfnt|vnd\.ms-fontobject)$/.test(type)) return type
  if (isMediaType(type)) return media ? type : null
  if (type === 'application/octet-stream' || type === '') return typeFromExtension(pathname, media)
  return null
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function fail(message, code, status) {
  return Object.assign(new Error(message), { code, status })
}

function decodeEntities(s) {
  return String(s).replace(/&(amp|quot|apos|lt|gt|#39|#x27);/g, (m, e) =>
    ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'", '#x27': "'" })[e])
}

function isStreamUrl(url, type) {
  return STREAM_RE.test(url) || STREAM_TYPE_RE.test(type || '')
}

/**
 * Collects what a batch of recorded events references:
 *   assets  - images, fonts, CSS, media
 *   frames  - cross-origin iframe documents the recorder couldn't read
 *   streams - HLS / DASH manifests behind <video> elements
 */
function extractArchiveTargets(events, { media = true } = {}) {
  const assets = new Set()
  const frames = new Set()
  const streams = new Set()
  const into = set => u => {
    if (typeof u === 'string' && u.length < 2048 && /^https?:\/\//i.test(u.trim()) && set.size < MAX_URLS_PER_BATCH) set.add(u.trim())
  }
  const add = into(assets)
  const addFrame = into(frames)
  const addStream = into(streams)
  const addCss = css => {
    if (typeof css !== 'string' || (css.indexOf('url(') === -1 && css.indexOf('@import') === -1)) return
    css.replace(CSS_URL_RE, (m, q, u) => add(u))
    css.replace(CSS_IMPORT_RE, (m, q, u) => add(u))
  }
  const addSrcset = v => String(v).split(',').forEach(p => add(p.trim().split(/\s+/)[0]))
  const addMedia = (src, type) => {
    if (!media || typeof src !== 'string') return
    if (isStreamUrl(src, type)) addStream(src)
    else add(src)
  }
  const addAttrs = (tag, a, sn) => {
    // Attribute mutations carry no tag name: any changed src is a candidate (the type filter rejects scripts).
    if (tag === null || tag === 'img' || tag === 'image' || (tag === 'input' && a.type === 'image')) {
      if (tag === null && isStreamUrl(a.src || '')) addMedia(a.src)
      else add(a.src)
      add(a.href)
      add(a['xlink:href'])
    }
    if (tag === 'source') addMedia(a.src, a.type)
    if (tag === 'video' || tag === 'audio') addMedia(a.src)
    if ((tag === 'iframe' || tag === 'frame') && sn && sn.remote) addFrame(a.src)
    if (tag === 'link' && /stylesheet|icon/i.test(a.rel || '') && !(sn && sn.cssText != null)) add(a.href)
    if (a.srcset) addSrcset(a.srcset)
    if (a.poster) add(a.poster)
    if (a.background) add(a.background)
    if (a.style) addCss(a.style)
  }

  // Iterative walk: recorded trees can be arbitrarily deep.
  const walk = rootNode => {
    const stack = [[rootNode, null]]
    while (stack.length) {
      const [sn, parentTag] = stack.pop()
      if (!sn || typeof sn !== 'object') continue
      if (sn.type === 3 && parentTag === 'style') addCss(sn.text)
      if (sn.type === 1) {
        addAttrs(sn.tag, sn.attrs || {}, sn)
        if (sn.cssText) addCss(sn.cssText)
        if (media && typeof sn.stream === 'string') addStream(sn.stream)
      }
      if (Array.isArray(sn.adopted)) sn.adopted.forEach(r => r && addCss(r.css))
      if (Array.isArray(sn.childNodes)) for (const c of sn.childNodes) stack.push([c, sn.type === 1 ? sn.tag : null])
      if (sn.shadow) stack.push([sn.shadow, null])
      if (sn.doc) stack.push([sn.doc, null])
    }
  }

  for (const ev of events) {
    const d = ev.data
    if (!d || typeof d !== 'object') continue
    switch (ev.type) {
      case 'snapshot':
      case 'shadow':
        walk(d.node)
        break
      case 'iframe':
        if (d.node) walk(d.node)
        else addFrame(d.url)
        break
      case 'mutation':
        for (const a of Array.isArray(d.adds) ? d.adds : []) walk(a && a.node)
        for (const a of Array.isArray(d.attrs) ? d.attrs : []) if (a && a.attrs) addAttrs(null, a.attrs, null)
        break
      case 'adopted':
        for (const r of Array.isArray(d.sheets) ? d.sheets : []) if (r) addCss(r.css)
        break
      case 'style':
        addCss(d.rule)
        addCss(d.css)
        break
      case 'stream':
        if (media) addStream(d.url)
        break
    }
  }
  return { assets, frames, streams }
}

/** Collects archivable asset URLs referenced by a batch of recorded events. */
function extractAssetUrls(events, options) {
  return extractArchiveTargets(events, options).assets
}

/** Asset URLs referenced by an HTML document (best effort, without a full parser). */
function extractHtmlUrls(html, pageUrl) {
  const urls = new Set()
  let base = pageUrl
  const baseTag = html.match(/<base\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
  if (baseTag) {
    try { base = new URL(decodeEntities(baseTag[1] || baseTag[2] || baseTag[3]), pageUrl).href } catch (e) { /* keep */ }
  }
  const add = u => {
    if (urls.size >= MAX_URLS_PER_BATCH || !u) return
    try {
      const abs = new URL(decodeEntities(u.trim()), base).href
      if (/^https?:/i.test(abs)) urls.add(abs)
    } catch (e) { /* invalid URL */ }
  }
  const addCss = css => {
    css.replace(CSS_URL_RE, (m, q, u) => add(u))
    css.replace(CSS_IMPORT_RE, (m, q, u) => add(u))
  }
  const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  html.replace(/<([a-z]+)\b([^>]*)>/gi, (m, tagName, attrText) => {
    const tag = tagName.toLowerCase()
    const a = {}
    attrText.replace(ATTR_RE, (x, name, v1, v2, v3) => { a[name.toLowerCase()] = v1 != null ? v1 : v2 != null ? v2 : v3 })
    if (tag === 'img' || tag === 'source' || tag === 'image' || tag === 'video' || tag === 'audio' || (tag === 'input' && /^image$/i.test(a.type || ''))) add(a.src)
    if (tag === 'link' && /stylesheet|icon/i.test(a.rel || '')) add(a.href)
    if (a.srcset) decodeEntities(a.srcset).split(',').forEach(p => add(p.trim().split(/\s+/)[0]))
    if (a.poster) add(a.poster)
    if (a.background) add(a.background)
    if (a.style) addCss(decodeEntities(a.style))
    return m
  })
  html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => { addCss(css); return m })
  return urls
}

// ---------------------------------------------------------------- stream manifests

function attrList(s) {
  const out = {}
  String(s).replace(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g, (m, k, v, quoted) => { out[k] = quoted != null ? quoted : v })
  return out
}

function hlsRange(spec, previousEnd) {
  const [len, off] = String(spec).split('@').map(Number)
  if (!Number.isFinite(len)) return null
  const start = Number.isFinite(off) ? off : previousEnd
  return [start, start + len - 1]
}

/** Parses an HLS playlist (master or media). */
function parseHls(text, base) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const out = { variants: [], map: null, segments: [], ended: false, encrypted: false }
  let pendingVariant = null
  let pendingRange = null
  const ends = new Map() // url -> end of its last byte range, for ranges without an offset
  const resolve = u => new URL(u, base).href
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrList(line.slice(18))
      pendingVariant = { bandwidth: Number(a.BANDWIDTH) || 0, video: !!a.RESOLUTION || !/^mp4a/.test(a.CODECS || 'avc') }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrList(line.slice(11))
      if (a.URI) {
        const url = resolve(a.URI)
        out.map = { url, range: a.BYTERANGE ? hlsRange(a.BYTERANGE, 0) : null }
        if (out.map.range) ends.set(url, out.map.range[1] + 1)
      }
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attrList(line.slice(11))
      if (a.METHOD && a.METHOD !== 'NONE') out.encrypted = true
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(17)
    } else if (line === '#EXT-X-ENDLIST') {
      out.ended = true
    } else if (!line.startsWith('#')) {
      const url = resolve(line)
      if (pendingVariant) {
        out.variants.push(Object.assign(pendingVariant, { url }))
        pendingVariant = null
      } else {
        const range = pendingRange ? hlsRange(pendingRange, ends.get(url) || 0) : null
        if (range) ends.set(url, range[1] + 1)
        out.segments.push({ url, range })
        pendingRange = null
      }
    }
  }
  return out
}

function pickVariant(variants) {
  const video = variants.filter(v => v.video)
  const pool = video.length ? video : variants
  const fitting = pool.filter(v => v.bandwidth <= PREFERRED_STREAM_BANDWIDTH)
  if (fitting.length) return fitting.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a))
  return pool.reduce((a, b) => (b.bandwidth < a.bandwidth ? b : a))
}

function xmlAttrs(s) {
  const out = {}
  String(s || '').replace(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (m, k, v1, v2) => { out[k] = decodeEntities(v1 != null ? v1 : v2) })
  return out
}

function isoDuration(s) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || '').trim())
  if (!m) return 0
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0)
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$|\$\$/g, (m, name, width) => {
    if (!name) return '$'
    const v = String(vars[name])
    return width ? v.padStart(Number(width), '0') : v
  })
}

function baseUrlIn(xml, base) {
  const m = /<BaseURL[^>]*>([^<]*)<\/BaseURL>/.exec(xml)
  return m ? new URL(decodeEntities(m[1].trim()), base).href : base
}

/** Turns a DASH MPD into the list of files that make up its video representation. */
function parseDash(xml, manifestUrl) {
  const mpd = /<MPD\b([^>]*)>/.exec(xml)
  if (!mpd) throw fail('not a DASH manifest', 'EUNSUPPORTED')
  const mpdAttrs = xmlAttrs(mpd[1])
  if (mpdAttrs.type === 'dynamic') throw fail('live DASH streams are not archived', 'EUNSUPPORTED')
  const period = /<Period\b([^>]*)>([\s\S]*?)<\/Period>/.exec(xml)
  if (!period) throw fail('DASH manifest without a Period', 'EUNSUPPORTED')
  const totalSeconds = isoDuration(mpdAttrs.mediaPresentationDuration) || isoDuration(xmlAttrs(period[1]).duration)
  let base = baseUrlIn(xml.slice(0, period.index), manifestUrl)
  base = baseUrlIn(period[2].split('<AdaptationSet')[0], base)

  const reps = []
  period[2].replace(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g, (m, setAttrText, setBody) => {
    const setAttrs = xmlAttrs(setAttrText)
    const setHead = setBody.split('<Representation')[0]
    setBody.replace(/<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/g, (r, a, body) => {
      const attrs = xmlAttrs(a)
      const mime = attrs.mimeType || setAttrs.mimeType || ''
      if (/^video\//.test(mime) || setAttrs.contentType === 'video' || attrs.width || setAttrs.width) {
        reps.push({ attrs, body: body || '', setHead, mime: mime || 'video/mp4', bandwidth: Number(attrs.bandwidth) || 0, video: true })
      }
      return r
    })
    return m
  })
  if (!reps.length) throw fail('no video representation in DASH manifest', 'EUNSUPPORTED')
  const rep = pickVariant(reps)
  const repBase = baseUrlIn(rep.body, baseUrlIn(rep.setHead, base))
  const contentType = /webm/.test(rep.mime) ? 'video/webm' : 'video/mp4'

  const templateRe = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/
  const tpl = templateRe.exec(rep.body) || templateRe.exec(rep.setHead)
  if (tpl) {
    const t = xmlAttrs(tpl[1])
    if (!t.media) throw fail('DASH SegmentTemplate without media', 'EUNSUPPORTED')
    const timescale = Number(t.timescale) || 1
    const vars = { RepresentationID: rep.attrs.id || '', Bandwidth: rep.attrs.bandwidth || '', Number: 0, Time: 0 }
    const parts = []
    if (t.initialization) parts.push({ url: new URL(fillTemplate(t.initialization, vars), repBase).href })
    let number = t.startNumber != null ? Number(t.startNumber) : 1
    const push = time => {
      if (parts.length > MAX_STREAM_SEGMENTS) return
      parts.push({ url: new URL(fillTemplate(t.media, Object.assign(vars, { Number: number++, Time: time })), repBase).href })
    }
    const timeline = tpl[2] && /<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/.exec(tpl[2])
    if (timeline) {
      let time = 0
      const end = totalSeconds * timescale
      timeline[1].replace(/<S\b([^>]*?)\/?>/g, (m, a) => {
        const s = xmlAttrs(a)
        if (s.t != null) time = Number(s.t)
        const d = Number(s.d)
        let repeat = Number(s.r || 0)
        if (repeat < 0) repeat = end ? Math.ceil((end - time) / d) - 1 : 0
        for (let i = 0; i <= repeat && d > 0 && parts.length <= MAX_STREAM_SEGMENTS; i++) {
          push(time)
          time += d
        }
        return m
      })
    } else if (t.duration && totalSeconds) {
      const count = Math.min(Math.ceil(totalSeconds * timescale / Number(t.duration)), MAX_STREAM_SEGMENTS)
      for (let i = 0; i < count; i++) push(i * Number(t.duration))
    } else {
      throw fail('DASH SegmentTemplate without duration or timeline', 'EUNSUPPORTED')
    }
    return { contentType, parts }
  }
  const listRe = /<SegmentList\b[^>]*>([\s\S]*?)<\/SegmentList>/
  const list = listRe.exec(rep.body) || listRe.exec(rep.setHead)
  if (list) {
    const parts = []
    const init = /<Initialization\b([^>]*?)\/?>/.exec(list[1])
    if (init && xmlAttrs(init[1]).sourceURL) parts.push({ url: new URL(xmlAttrs(init[1]).sourceURL, repBase).href })
    list[1].replace(/<SegmentURL\b([^>]*?)\/?>/g, (m, a) => {
      const media = xmlAttrs(a).media
      if (media && parts.length <= MAX_STREAM_SEGMENTS) parts.push({ url: new URL(media, repBase).href })
      return m
    })
    return { contentType, parts }
  }
  // SegmentBase or a bare BaseURL: the representation is one ordinary file.
  if (repBase !== manifestUrl) return { contentType, parts: [{ url: repBase }], single: true }
  throw fail('unsupported DASH addressing', 'EUNSUPPORTED')
}

// ---------------------------------------------------------------- archiver

class AssetArchiver {
  constructor(store, {
    allowPrivate = false, maxBytes = 5 * 1024 * 1024, archiveMedia = true, mediaMaxBytes = 200 * 1024 * 1024,
    archiveFrames = true, timeoutMs = 10000, concurrency = 4, allowedHosts = [], hostHeaders = {}, log = () => {}
  } = {}) {
    this.store = store
    this.maxBytes = maxBytes
    this.archiveMedia = archiveMedia
    this.mediaMaxBytes = mediaMaxBytes
    this.archiveFrames = archiveFrames
    this.timeoutMs = timeoutMs
    this.concurrency = concurrency
    this.allowedHosts = allowedHosts
    this.hostHeaders = hostHeaders
    this.log = log
    this.allowPrivate = allowPrivate
    this.lookup = guardedLookup(allowPrivate)
    this.cache = new Map()    // '<kind> <url>' -> { hash | null, at }
    this.inflight = new Map() // '<kind> <url>' -> Promise<hash | null>
    this.missing = new Map()  // 'appId/sessionId' -> Set of URLs that could not be fetched, for the SDK to upload
    this.tasks = new Set()
    this.running = 0
    this.waiting = []
    this.tmpDir = null
  }

  /** Archives the assets of a batch in the background; the returned promise is only for tests. */
  enqueue(appId, sessionId, events) {
    const targets = extractArchiveTargets(events, { media: this.archiveMedia })
    if (!this.archiveFrames) targets.frames.clear()
    if (!targets.assets.size && !targets.frames.size && !targets.streams.size) return Promise.resolve()
    const task = this._archiveSession(appId, sessionId, targets)
      .catch(e => this.log('asset archiving failed:', e.message))
    this.tasks.add(task)
    task.then(() => this.tasks.delete(task))
    return task
  }

  async drain() {
    while (this.tasks.size) await Promise.all([...this.tasks])
  }

  async close() {
    await this.drain()
    if (this.tmpDir) {
      await fsp.rm(this.tmpDir, { recursive: true, force: true }).catch(() => {})
      this.tmpDir = null
    }
  }

  async _archiveSession(appId, sessionId, { assets, frames, streams }) {
    const map = {}
    const failed = []
    await Promise.all([
      ...[...assets].map(async url => {
        const hash = await this.archive(url, 0)
        if (hash) map[url] = hash
        else failed.push(url)
      }),
      // A stream's manifest URL maps to the flattened video file.
      ...[...streams].map(async url => {
        const hash = await this.archive(url, 0, 'stream')
        if (hash) map[url] = hash
      }),
      // Frame documents are keyed 'frame:<url>' so the viewer can tell them apart; their own assets are archived too.
      ...[...frames].map(async url => {
        const hash = await this.archive(url, 0, 'frame')
        if (!hash) return
        map['frame:' + url] = hash
        const doc = await this.store.getAsset(hash)
        if (!doc) return
        await Promise.all([...extractHtmlUrls(doc.body.toString('utf8'), url)].map(async sub => {
          const subHash = await this.archive(sub, 0)
          if (subHash) map[sub] = subHash
        }))
      })
    ])
    if (Object.keys(map).length) await this.store.addSessionAssets(appId, sessionId, map)
    if (failed.length) this._addMissing(appId, sessionId, failed)
  }

  _addMissing(appId, sessionId, urls) {
    const key = appId + '/' + sessionId
    const set = this.missing.get(key) || new Set()
    for (const url of urls) if (set.size < MAX_MISSING_PER_SESSION) set.add(url)
    this.missing.delete(key) // re-insert to keep the most recently active sessions
    this.missing.set(key, set)
    if (this.missing.size > MAX_MISSING_SESSIONS) this.missing.delete(this.missing.keys().next().value)
  }

  /** URLs of this session the server could not archive since the last call; the SDK may upload them. */
  takeMissing(appId, sessionId) {
    const key = appId + '/' + sessionId
    const set = this.missing.get(key)
    if (!set) return []
    this.missing.delete(key)
    return [...set]
  }

  /** Stores an asset the SDK fetched in the browser (with the user's cookies) and maps it to its URL. */
  async storeUpload(appId, sessionId, url, declaredType, body) {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      throw fail('invalid URL', 'EINVALID', 400)
    }
    if (!/^https?:$/.test(u.protocol)) throw fail('unsupported protocol', 'EINVALID', 400)
    const type = String(declaredType || '').split(';')[0].trim().toLowerCase()
    const contentType = archivableType(type, u.pathname, this.archiveMedia)
    if (!contentType) throw fail('not an archivable type: ' + (type || 'unknown'), 'ETYPE', 415)
    if (!body.length) throw fail('empty body', 'EINVALID', 400)
    if (body.length > this._maxBytesFor(contentType)) throw fail('too large', 'ELIMIT', 413)
    const hash = await this._store(u.href, { contentType, body }, 0)
    await this.store.addSessionAssets(appId, sessionId, { [url]: hash })
    return hash
  }

  _maxBytesFor(contentType) {
    return isMediaType(contentType) ? this.mediaMaxBytes : this.maxBytes
  }

  archive(url, depth, kind = 'asset') {
    const key = kind === 'asset' ? url : kind + ' ' + url
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.hash)
    if (this.inflight.has(key)) return this.inflight.get(key)
    const work = kind === 'stream' ? this._archiveStream(url)
      : kind === 'frame' ? this._limit(() => this.fetchAsset(url, { kind: 'frame' })).then(a => this._store(url, a, depth))
        : this._fetchAndStore(url, depth)
    const p = work
      .catch(e => {
        if (e.code !== 'EPRIVATE') this.log(`${kind} ${url} not archived: ${e.message}`)
        return null
      })
      .then(hash => {
        this.cache.set(key, { hash, at: Date.now() })
        this.inflight.delete(key)
        if (this.cache.size > 10000) this.cache.delete(this.cache.keys().next().value)
        return hash
      })
    this.inflight.set(key, p)
    return p
  }

  // Concurrency applies to network fetches only; CSS sub-resources are archived after the slot is released.
  async _limit(fn) {
    if (this.running >= this.concurrency) await new Promise(resolve => this.waiting.push(resolve))
    this.running++
    try {
      return await fn()
    } finally {
      this.running--
      const next = this.waiting.shift()
      if (next) next()
    }
  }

  async _fetchAndStore(url, depth) {
    const asset = await this._limit(() => this.fetchAsset(url))
    return this._store(url, asset, depth)
  }

  // asset: { contentType, body } in memory, or { contentType, file, hash } on disk (media).
  async _store(url, asset, depth) {
    let { contentType, body } = asset
    if (asset.file) {
      try {
        if (!(await this.store.hasAsset(asset.hash))) await this.store.putAssetFile(asset.hash, contentType, asset.file)
        return asset.hash
      } finally {
        await fsp.rm(asset.file, { force: true }).catch(() => {})
      }
    }
    if (contentType === 'text/css') {
      body = Buffer.from(await this._rewriteCss(body.toString('utf8'), url, depth), 'utf8')
      contentType = 'text/css; charset=utf-8'
    }
    const hash = sha256(body)
    if (!(await this.store.hasAsset(hash))) await this.store.putAsset(hash, contentType, body)
    return hash
  }

  // Points the stylesheet's own references (fonts, images, @imports) at archived copies, or at absolute URLs.
  async _rewriteCss(css, baseUrl, depth) {
    const refs = new Set()
    css.replace(CSS_URL_RE, (m, q, u) => refs.add(u.trim()))
    css.replace(CSS_IMPORT_RE, (m, q, u) => refs.add(u.trim()))
    const resolved = new Map()
    await Promise.all([...refs].map(async ref => {
      if (/^(data:|#)/i.test(ref)) return
      let abs
      try {
        abs = new URL(ref, baseUrl).href
      } catch (e) {
        return
      }
      if (!/^https?:/i.test(abs)) return
      const hash = depth < MAX_CSS_DEPTH ? await this.archive(abs, depth + 1) : null
      resolved.set(ref, hash ? '/assets/' + hash : abs)
    }))
    return css
      .replace(CSS_URL_RE, (m, q, u) => (resolved.has(u.trim()) ? `url(${q}${resolved.get(u.trim())}${q})` : m))
      .replace(CSS_IMPORT_RE, (m, q, u) => (resolved.has(u.trim()) ? `@import ${q}${resolved.get(u.trim())}${q}` : m))
  }

  async _tmpFile() {
    if (!this.tmpDir) this.tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'logit-archive-'))
    return path.join(this.tmpDir, crypto.randomBytes(8).toString('hex'))
  }

  // HLS (fragmented MP4) and DASH are flattened into one file: init segment + media segments in order,
  // which browsers play as a regular video. Streams above the media limit keep their first segments.
  async _archiveStream(url) {
    const manifest = await this._limit(() => this.fetchAsset(url, { kind: 'manifest' }))
    let plan
    if (/^\s*#EXTM3U/.test(manifest.text)) plan = await this._hlsPlan(manifest.text, manifest.url)
    else if (/<MPD[\s>]/.test(manifest.text)) plan = parseDash(manifest.text, manifest.url)
    else throw fail('not an HLS or DASH manifest', 'EUNSUPPORTED')
    if (plan.single) {
      const hash = await this.archive(plan.parts[0].url, 0)
      if (!hash) throw fail('stream file not archived', 'EFETCH')
      return hash
    }

    const file = await this._tmpFile()
    const out = fs.createWriteStream(file)
    const hasher = crypto.createHash('sha256')
    let size = 0
    let segments = 0
    try {
      for (const part of plan.parts) {
        let res
        try {
          res = await this._limit(() => this.fetchAsset(part.url, { kind: 'segment', range: part.range, maxBytes: this.mediaMaxBytes - size }))
        } catch (e) {
          if (e.code === 'ELIMIT' && segments > 1) break // init + at least one segment fit: keep the beginning
          throw e
        }
        hasher.update(res.body)
        size += res.body.length
        segments++
        if (!out.write(res.body)) await new Promise(resolve => out.once('drain', resolve))
      }
      await new Promise((resolve, reject) => out.end(e => (e ? reject(e) : resolve())))
    } catch (e) {
      out.destroy()
      await fsp.rm(file, { force: true }).catch(() => {})
      throw e
    }
    return this._store(url, { contentType: plan.contentType, file, hash: hasher.digest('hex') }, 0)
  }

  async _hlsPlan(text, base) {
    let playlist = parseHls(text, base)
    if (playlist.variants.length) {
      const variant = pickVariant(playlist.variants)
      const media = await this._limit(() => this.fetchAsset(variant.url, { kind: 'manifest' }))
      playlist = parseHls(media.text, media.url)
    }
    if (!playlist.ended) throw fail('live HLS streams are not archived', 'EUNSUPPORTED')
    if (playlist.encrypted) throw fail('encrypted HLS streams are not archived', 'EUNSUPPORTED')
    if (!playlist.map) throw fail('MPEG-TS HLS segments only play in an HLS player', 'EUNSUPPORTED')
    if (!playlist.segments.length) throw fail('empty HLS playlist', 'EUNSUPPORTED')
    return { contentType: 'video/mp4', parts: [playlist.map].concat(playlist.segments.slice(0, MAX_STREAM_SEGMENTS)) }
  }

  _headersFor(hostname) {
    const out = {}
    for (const pattern of Object.keys(this.hostHeaders)) {
      const match = pattern.startsWith('*.')
        ? hostname.endsWith(pattern.slice(1))
        : hostname === pattern
      if (match) Object.assign(out, this.hostHeaders[pattern])
    }
    return out
  }

  /**
   * Fetches one URL. kind:
   *   'asset'    archivable types only; media streams to a temp file and may be truncated at the limit
   *   'frame'    HTML only, re-encoded as UTF-8
   *   'manifest' an HLS / DASH manifest, as text
   *   'segment'  any bytes (part of a stream), optionally a byte range, at most maxBytes
   */
  fetchAsset(url, { kind = 'asset', range = null, maxBytes = null, redirectsLeft = 3 } = {}) {
    return new Promise((resolve, reject) => {
      let u
      try {
        u = new URL(url)
      } catch (e) {
        return reject(new Error('invalid URL'))
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('unsupported protocol'))
      if (this.allowedHosts.length && !this.allowedHosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) {
        return reject(new Error('host not in LOGIT_ASSET_HOSTS'))
      }
      // Node skips the lookup hook for IP-literal hosts, so check those here.
      const literal = u.hostname.replace(/^\[|\]$/g, '')
      if (!this.allowPrivate && net.isIP(literal) && isPrivateAddress(literal)) {
        return reject(fail(`refusing private address ${literal}`, 'EPRIVATE'))
      }
      // Configured credentials only go to their own host: recomputed on every redirect hop.
      const headers = Object.assign({ 'user-agent': 'LogIt-Asset-Archiver/1.0', accept: '*/*' }, this._headersFor(u.hostname))
      if (range) headers.range = `bytes=${range[0]}-${range[1]}`
      let handedOff = false
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.get(u, { lookup: this.lookup, timeout: this.timeoutMs, agent: false, headers }, res => {
        const status = res.statusCode
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'))
          return resolve(this.fetchAsset(new URL(res.headers.location, u).href, { kind, range, maxBytes, redirectsLeft: redirectsLeft - 1 }))
        }
        if (status !== 200 && !(range && status === 206)) {
          res.resume()
          return reject(new Error('HTTP ' + status))
        }
        const rawType = String(res.headers['content-type'] || '')
        const declared = rawType.split(';')[0].trim().toLowerCase()
        let contentType = declared
        let limit
        if (kind === 'segment') {
          limit = maxBytes
        } else if (kind === 'manifest') {
          limit = MAX_MANIFEST_BYTES
        } else if (kind === 'frame') {
          if (declared !== 'text/html' && declared !== 'application/xhtml+xml') {
            res.resume()
            return reject(new Error('not an HTML document: ' + (declared || 'unknown')))
          }
          limit = this.maxBytes
        } else {
          contentType = archivableType(declared, u.pathname, this.archiveMedia)
          if (!contentType) {
            res.resume()
            return reject(new Error('not an archivable type: ' + (declared || 'unknown')))
          }
          limit = this._maxBytesFor(contentType)
          if (isMediaType(contentType)) {
            handedOff = true
            return this._receiveMedia(res, contentType, limit).then(resolve, reject)
          }
        }
        if (Number(res.headers['content-length']) > limit) {
          res.destroy()
          return reject(fail('too large', 'ELIMIT'))
        }
        const chunks = []
        let size = 0
        res.on('data', chunk => {
          size += chunk.length
          if (size > limit) {
            res.destroy()
            reject(fail('too large', 'ELIMIT'))
          } else {
            chunks.push(chunk)
          }
        })
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          if (kind === 'manifest') return resolve({ url: u.href, text: body.toString('utf8') })
          if (kind === 'frame') return resolve({ url: u.href, contentType: 'text/html; charset=utf-8', body: toUtf8Html(body, rawType) })
          resolve({ url: u.href, contentType, body })
        })
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', e => { if (!handedOff) reject(e) })
    })
  }

  // Media goes to a temp file, hashed on the way. Over the limit, formats that play from a prefix are cut
  // at the limit (long videos keep their beginning); anything else is rejected.
  async _receiveMedia(res, contentType, limit) {
    const truncatable = TRUNCATABLE_RE.test(contentType)
    if (!truncatable && Number(res.headers['content-length']) > limit) {
      res.destroy()
      throw fail('too large', 'ELIMIT')
    }
    const file = await this._tmpFile()
    const out = fs.createWriteStream(file)
    const hasher = crypto.createHash('sha256')
    let size = 0
    let truncated = false
    try {
      await new Promise((resolve, reject) => {
        res.on('data', chunk => {
          if (truncated) return
          if (size + chunk.length > limit) {
            if (!truncatable) {
              res.destroy()
              return reject(fail('too large', 'ELIMIT'))
            }
            chunk = chunk.subarray(0, limit - size)
            truncated = true
          }
          size += chunk.length
          hasher.update(chunk)
          if (!out.write(chunk) && !truncated) {
            res.pause()
            out.once('drain', () => res.resume())
          }
          if (truncated) {
            res.destroy()
            resolve()
          }
        })
        res.on('end', resolve)
        res.on('error', e => (truncated ? resolve() : reject(e)))
      })
      await new Promise((resolve, reject) => out.end(e => (e ? reject(e) : resolve())))
      if (truncated && /mp4|quicktime/.test(contentType) && !(await mp4PlaysFromStart(file, size))) {
        throw fail('too large (the MP4 index is at the end of the file)', 'ELIMIT')
      }
      return { contentType, file, hash: hasher.digest('hex'), size, truncated }
    } catch (e) {
      out.destroy()
      await fsp.rm(file, { force: true }).catch(() => {})
      throw e
    }
  }
}

// A truncated MP4 only plays if its index ('moov') is complete and comes before the media data ('mdat').
async function mp4PlaysFromStart(file, size) {
  const fh = await fsp.open(file, 'r')
  try {
    const head = Buffer.alloc(16)
    let offset = 0
    while (offset + 8 <= size) {
      await fh.read(head, 0, 16, offset)
      let boxSize = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8))
      else if (boxSize === 0) boxSize = size - offset
      if (type === 'moov') return offset + boxSize <= size
      if (type === 'mdat' || boxSize < 8) return false
      offset += boxSize
    }
    return false
  } finally {
    await fh.close()
  }
}

function toUtf8Html(body, contentTypeHeader) {
  let charset = (/charset\s*=\s*["']?([\w-]+)/i.exec(contentTypeHeader) || [])[1]
  if (!charset) charset = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString('latin1')) || [])[1]
  if (!charset || /^utf-?8$/i.test(charset)) return body
  try {
    return Buffer.from(new TextDecoder(charset).decode(body), 'utf8')
  } catch (e) {
    return body
  }
}

module.exports = {
  AssetArchiver, extractAssetUrls, extractArchiveTargets, extractHtmlUrls, isPrivateAddress, parseHls, parseDash
}
