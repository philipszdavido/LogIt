'use strict'

// Archives the images, fonts and stylesheets a recorded page references, so replays keep working
// after the site deploys new assets. Assets are stored content-addressed and served from /assets/<sha256>.

const http = require('http')
const https = require('https')
const dns = require('dns')
const net = require('net')
const crypto = require('crypto')

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
const CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi
const FONT_TYPES = { woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject' }
const MAX_URLS_PER_BATCH = 300
const MAX_CSS_DEPTH = 3
const CACHE_TTL_MS = 10 * 60 * 1000

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

function fontTypeFor(pathname) {
  const m = pathname.toLowerCase().match(/\.(woff2?|ttf|otf|eot)$/)
  return m ? FONT_TYPES[m[1]] : null
}

// Only passive resources are archived: never HTML or scripts.
function archivableType(type, pathname) {
  if (/^image\//.test(type) || /^font\//.test(type) || type === 'text/css') return type
  if (/^application\/(font-woff2?|x-font-[\w-]+|font-sfnt|vnd\.ms-fontobject)$/.test(type)) return type
  if (type === 'application/octet-stream' || type === '') return fontTypeFor(pathname)
  return null
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** Collects archivable asset URLs referenced by a batch of recorded events. */
function extractAssetUrls(events) {
  const urls = new Set()
  const add = u => {
    if (typeof u === 'string' && u.length < 2048 && /^https?:\/\//i.test(u) && urls.size < MAX_URLS_PER_BATCH) urls.add(u.trim())
  }
  const addCss = css => {
    if (typeof css !== 'string' || (css.indexOf('url(') === -1 && css.indexOf('@import') === -1)) return
    css.replace(CSS_URL_RE, (m, q, u) => add(u))
    css.replace(CSS_IMPORT_RE, (m, q, u) => add(u))
  }
  const addSrcset = v => String(v).split(',').forEach(p => add(p.trim().split(/\s+/)[0]))
  const addAttrs = (tag, a, sn) => {
    // Attribute mutations carry no tag name: any changed src is a candidate (the type filter rejects scripts).
    if (tag === null || tag === 'img' || tag === 'source' || tag === 'image' || (tag === 'input' && a.type === 'image')) {
      add(a.src)
      add(a.href)
      add(a['xlink:href'])
    }
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
      case 'iframe':
        walk(d.node)
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
    }
  }
  return urls
}

class AssetArchiver {
  constructor(store, { allowPrivate = false, maxBytes = 5 * 1024 * 1024, timeoutMs = 10000, concurrency = 4, allowedHosts = [], log = () => {} } = {}) {
    this.store = store
    this.maxBytes = maxBytes
    this.timeoutMs = timeoutMs
    this.concurrency = concurrency
    this.allowedHosts = allowedHosts
    this.log = log
    this.allowPrivate = allowPrivate
    this.lookup = guardedLookup(allowPrivate)
    this.cache = new Map()    // url -> { hash | null, at }
    this.inflight = new Map() // url -> Promise<hash | null>
    this.tasks = new Set()
    this.running = 0
    this.waiting = []
  }

  /** Archives the assets of a batch in the background; the returned promise is only for tests. */
  enqueue(appId, sessionId, events) {
    const urls = extractAssetUrls(events)
    if (!urls.size) return Promise.resolve()
    const task = this._archiveSession(appId, sessionId, [...urls])
      .catch(err => this.log('asset archiving failed:', err.message))
    this.tasks.add(task)
    task.then(() => this.tasks.delete(task))
    return task
  }

  async drain() {
    while (this.tasks.size) await Promise.all([...this.tasks])
  }

  async _archiveSession(appId, sessionId, urls) {
    const map = {}
    await Promise.all(urls.map(async url => {
      const hash = await this.archive(url, 0)
      if (hash) map[url] = hash
    }))
    if (Object.keys(map).length) await this.store.addSessionAssets(appId, sessionId, map)
  }

  archive(url, depth) {
    const cached = this.cache.get(url)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.hash)
    if (this.inflight.has(url)) return this.inflight.get(url)
    const p = this._fetchAndStore(url, depth)
      .catch(err => {
        if (err.code !== 'EPRIVATE') this.log(`asset ${url} not archived: ${err.message}`)
        return null
      })
      .then(hash => {
        this.cache.set(url, { hash, at: Date.now() })
        this.inflight.delete(url)
        if (this.cache.size > 10000) this.cache.delete(this.cache.keys().next().value)
        return hash
      })
    this.inflight.set(url, p)
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
    let body = asset.body
    let contentType = asset.contentType
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

  fetchAsset(url, redirectsLeft = 3) {
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
        return reject(Object.assign(new Error(`refusing private address ${literal}`), { code: 'EPRIVATE' }))
      }
      const mod = u.protocol === 'https:' ? https : http
      const req = mod.get(u, {
        lookup: this.lookup,
        timeout: this.timeoutMs,
        agent: false,
        headers: { 'user-agent': 'LogIt-Asset-Archiver/1.0', accept: '*/*' }
      }, res => {
        const status = res.statusCode
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'))
          return resolve(this.fetchAsset(new URL(res.headers.location, u).href, redirectsLeft - 1))
        }
        if (status !== 200) {
          res.resume()
          return reject(new Error('HTTP ' + status))
        }
        const declared = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
        const contentType = archivableType(declared, u.pathname)
        if (!contentType) {
          res.resume()
          return reject(new Error('not an archivable type: ' + (declared || 'unknown')))
        }
        if (Number(res.headers['content-length']) > this.maxBytes) {
          res.destroy()
          return reject(new Error('too large'))
        }
        const chunks = []
        let size = 0
        res.on('data', chunk => {
          size += chunk.length
          if (size > this.maxBytes) {
            res.destroy()
            reject(new Error('too large'))
          } else {
            chunks.push(chunk)
          }
        })
        res.on('end', () => resolve({ contentType, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', reject)
    })
  }
}

module.exports = { AssetArchiver, extractAssetUrls, isPrivateAddress }
