/*!
 * LogIt recorder SDK
 * Records DOM snapshots + mutations (including shadow DOM, same-origin iframes, canvas, media and
 * constructable stylesheets), user interactions, console output, errors, network requests and
 * performance data, and ships them in batches to a LogIt server.
 *
 * Install (as early in <head> as possible):
 *   <script src="https://your-logit-host/sdk/logit.js" data-app-id="my-app"></script>
 * or
 *   LogIt.init({ appId: 'my-app', endpoint: 'https://your-logit-host/api/ingest' })
 */
(function (window) {
  'use strict'
  if (typeof window === 'undefined' || !window.document) return
  if (window.LogIt && window.LogIt.__loaded) return

  var document = window.document
  var VERSION = '1.1.0'
  var SVG_NS = 'http://www.w3.org/2000/svg'
  var STORAGE_KEY = 'logit_session'
  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/
  var DROP_ATTR_RE = /^on/i
  var STYLESHEET_RE = /(^|\s)stylesheet(\s|$)/i
  var URL_ATTRS = { href: 1, src: 1, action: 1, poster: 1, background: 1, 'xlink:href': 1, cite: 1, data: 1 }
  var MEDIA_EVENTS = ['play', 'pause', 'seeked', 'ratechange', 'volumechange']

  var DEFAULTS = {
    appId: null,
    endpoint: null,             // ingest URL; without it events stay in memory (LogIt.getEvents())
    viewerUrl: null,            // base URL of the viewer, defaults to <endpoint origin>/viewer/
    flushInterval: 5000,
    maxBatchSize: 500,          // events per request
    maxBufferSize: 10000,       // oldest events are dropped beyond this
    maxRetries: 5,
    sampleRate: 1,              // 0..1, decided once per session
    sessionTimeout: 30 * 60 * 1000,
    recordDom: true,
    recordInteractions: true,
    recordConsole: true,
    recordErrors: true,
    recordNetwork: true,
    recordPerformance: true,
    recordIframes: true,        // contents of same-origin iframes
    recordMedia: true,          // <video>/<audio> play, pause, seek, rate and volume
    recordCanvas: false,        // <canvas> frames, and frames of <video> that cannot be replayed from a URL
    canvasFps: 2,
    canvasQuality: 0.6,
    inlineStylesheets: true,    // embed readable <link rel=stylesheet> CSS so replays survive deploys
    consoleLevels: ['log', 'info', 'warn', 'error', 'debug'],
    maskAllInputs: false,
    maskInputTypes: ['password'],          // 'password' is always masked
    maskTextSelector: '[data-logit-mask]', // text and inputs inside are replaced with *
    blockSelector: '[data-logit-block]',   // element is replaced by an empty placeholder
    networkBodies: true,
    maxBodySize: 10000,
    slowRequestThreshold: 1000,
    ignoreUrls: [],                        // strings (substring match) or RegExps
    sensitiveHeaders: ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'],
    beforeSend: null,                      // function (event) -> event | null, for scrubbing
    debug: false
  }

  // Captured before any patching so LogIt's own traffic and logging are never recorded.
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null
  var nativeConsole = {}
  if (window.console) {
    DEFAULTS.consoleLevels.forEach(function (level) {
      if (typeof console[level] === 'function') nativeConsole[level] = console[level]
    })
  }

  var config = null
  var active = false
  var buffer = []
  var sessionState = null
  var pageId = null
  var seq = 0
  var identity = null
  var nodeIds = new WeakMap()
  var blockedNodes = new WeakSet()
  var nextNodeId = 1
  var observer = null
  var flushTimer = null
  var canvasTimer = null
  var flushScheduled = false
  var inflight = null
  var failures = 0
  var backoffUntil = 0
  var needSnapshot = false
  var lastFallbackSnapshot = 0
  var patched = {}
  var inConsoleHook = false

  var closedRoots = new WeakMap()     // host -> closed ShadowRoot (only reachable through our attachShadow hook)
  var listenedRoots = new WeakSet()   // documents / shadow roots that have our event listeners
  var handledEvents = new WeakSet()   // composed events seen by more than one root listener
  var sheetIds = new WeakMap()        // constructed CSSStyleSheet -> id
  var nextSheetId = 1
  var sheetsSent = new WeakSet()      // sheets whose CSS was already sent since the last full snapshot
  var canvases = new Set()
  var lastFrames = new WeakMap()
  var frameCanvas = null

  // ---------------------------------------------------------------- utils

  function now() { return Date.now() }

  function debug() {
    if (config && config.debug && nativeConsole.log) {
      nativeConsole.log.apply(console, ['[LogIt]'].concat([].slice.call(arguments)))
    }
  }

  function warn(msg) { if (nativeConsole.warn) nativeConsole.warn.call(console, '[LogIt] ' + msg) }

  // Every hook into the host page goes through this so LogIt can never break it.
  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments) } catch (e) { debug('internal error', e) }
    }
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID()
    var bytes = new Uint8Array(16)
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes)
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2) }).join('')
  }

  function absUrl(url, base) {
    if (url == null || url === '') return url
    var s = String(url).trim()
    if (/^(data:|blob:|#|mailto:|tel:|about:)/i.test(s)) return s
    if (/^javascript:/i.test(s)) return 'javascript:void(0)'
    try { return new URL(s, base || document.baseURI).href } catch (e) { return s }
  }

  function absSrcset(value) {
    return String(value).split(',').map(function (part) {
      var bits = part.trim().split(/\s+/)
      if (bits[0]) bits[0] = absUrl(bits[0])
      return bits.join(' ')
    }).join(', ')
  }

  var CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
  function absCss(css, base) {
    if (!css || css.indexOf('url(') === -1) return css
    return css.replace(CSS_URL_RE, function (m, quote, u) { return 'url(' + quote + absUrl(u, base) + quote + ')' })
  }

  function truncate(s, max) {
    s = String(s)
    max = max || config.maxBodySize
    return s.length > max ? s.slice(0, max) + '…[truncated ' + (s.length - max) + ' chars]' : s
  }

  function matches(el, sel) {
    try { return !!(sel && el && el.nodeType === 1 && el.matches(sel)) } catch (e) { return false }
  }

  function closestMatch(el, sel) {
    try { return !!(sel && el && el.nodeType === 1 && el.closest(sel)) } catch (e) { return false }
  }

  function maskString(s) { return s ? String(s).replace(/\S/g, '*') : s }

  function describeEl(n) {
    if (!n) return ''
    if (n.nodeType !== 1) return n.nodeName.toLowerCase()
    var s = n.tagName.toLowerCase()
    if (n.id) s += '#' + n.id
    if (typeof n.className === 'string' && n.className.trim()) s += '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.')
    return s
  }

  function elementLabel(el) {
    var text = ''
    if (el && el.nodeType === 1 && !isInsideBlocked(el)) {
      var tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') text = el.getAttribute('name') || el.getAttribute('placeholder') || ''
      else text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
      if (closestMatch(el, config.maskTextSelector)) text = maskString(text)
    }
    return { selector: describeEl(el), text: text }
  }

  // Walks up through shadow hosts and iframe elements, not just parentNode.
  function parentOf(n) {
    if (n.parentNode) return n.parentNode
    if (n.nodeType === 11 && n.host) return n.host
    if (n.nodeType === 9) {
      try { return (n.defaultView && n.defaultView.frameElement) || null } catch (e) { return null }
    }
    return null
  }

  // The innermost target, even across open shadow boundaries.
  function realTarget(e) {
    var path = e.composedPath ? e.composedPath() : null
    return (path && path[0]) || e.target
  }

  function frameDoc(iframe) {
    try {
      var doc = iframe.contentDocument
      return doc && doc.documentElement ? doc : null
    } catch (e) {
      return null // cross-origin
    }
  }

  // Offset of a (same-origin, possibly nested) iframe document within the top-level viewport.
  function frameOffset(doc) {
    var x = 0
    var y = 0
    try {
      var win = doc.defaultView
      while (win && win !== window && win.frameElement) {
        var fe = win.frameElement
        var r = fe.getBoundingClientRect()
        x += r.left + fe.clientLeft
        y += r.top + fe.clientTop
        win = fe.ownerDocument.defaultView
      }
    } catch (e) { /* ignore */ }
    return { x: x, y: y }
  }

  // ---------------------------------------------------------------- events

  function emit(type, data, t) {
    if (!active) return
    var event = { t: t || now(), type: type, data: data }
    if (config.beforeSend) {
      try { event = config.beforeSend(event) } catch (e) { return }
      if (!event) return
    }
    buffer.push(event)
    trimBuffer()
    if (config.endpoint && buffer.length >= config.maxBatchSize) scheduleFlush(0)
  }

  function trimBuffer() {
    if (buffer.length <= config.maxBufferSize) return
    var dropped = buffer.splice(0, buffer.length - config.maxBufferSize)
    for (var i = 0; i < dropped.length; i++) {
      // Without its snapshot the remaining DOM mutations cannot be replayed.
      if (dropped[i].type === 'snapshot') needSnapshot = true
    }
    if (needSnapshot && config.recordDom) {
      needSnapshot = false
      setTimeout(safe(takeFullSnapshot), 0)
    }
  }

  // ---------------------------------------------------------------- masking

  function shouldMaskInput(el) {
    if (config.maskAllInputs) return true
    var type = (el.getAttribute('type') || '').toLowerCase()
    if (config.maskInputTypes.indexOf(type) !== -1) return true
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase()
    if (ac.indexOf('cc-') !== -1 || ac.indexOf('password') !== -1 || ac === 'one-time-code') return true
    return el.hasAttribute('data-logit-mask') || closestMatch(el, config.maskTextSelector)
  }

  function inputValue(el) {
    var v = el.value == null ? '' : String(el.value)
    return shouldMaskInput(el) ? new Array(v.length + 1).join('*') : v
  }

  function isInsideBlocked(n) {
    for (; n; n = parentOf(n)) if (blockedNodes.has(n)) return true
    return false
  }

  // ---------------------------------------------------------------- stylesheets

  function sheetText(sheet) {
    try {
      var rules = sheet && sheet.cssRules
      if (!rules || !rules.length) return null
      var out = ''
      for (var i = 0; i < rules.length; i++) out += rules[i].cssText + '\n'
      return absCss(out, sheet.href || undefined)
    } catch (e) {
      return null // cross-origin sheet without CORS
    }
  }

  // Constructed sheets are shared (e.g. one per component class), so their CSS is sent once per snapshot.
  function sheetRef(sheet) {
    var id = sheetIds.get(sheet)
    if (!id) {
      id = nextSheetId++
      sheetIds.set(sheet, id)
    }
    var ref = { id: id }
    if (!sheetsSent.has(sheet)) {
      sheetsSent.add(sheet)
      ref.css = sheetText(sheet) || ''
    }
    return ref
  }

  function serializeAdopted(root) {
    try {
      var list = root.adoptedStyleSheets
      if (!list || !list.length) return undefined
      return Array.prototype.map.call(list, sheetRef)
    } catch (e) {
      return undefined
    }
  }

  function notifySheet(sheet, data) {
    if (!active) return
    var id = sheetIds.get(sheet)
    if (!id) return
    data.sheetId = id
    emit('style', data)
  }

  // ---------------------------------------------------------------- canvas + media

  function replayableMedia(el) {
    return !el.srcObject && /^https?:/i.test(el.currentSrc || el.src || '')
  }

  function mediaState(el) {
    return {
      paused: el.paused,
      time: Math.round(el.currentTime * 100) / 100,
      rate: el.playbackRate,
      muted: el.muted,
      volume: el.volume,
      loop: el.loop
    }
  }

  function captureFrame(el) {
    try {
      if (el.tagName === 'VIDEO') {
        if (el.readyState < 2 || !el.videoWidth) return null
        var scale = Math.min(1, 640 / el.videoWidth)
        var c = frameCanvas || (frameCanvas = document.createElement('canvas'))
        c.width = Math.round(el.videoWidth * scale)
        c.height = Math.round(el.videoHeight * scale)
        c.getContext('2d').drawImage(el, 0, 0, c.width, c.height)
        return c.toDataURL('image/webp', config.canvasQuality)
      }
      if (!el.width || !el.height) return null
      return el.toDataURL('image/webp', config.canvasQuality)
    } catch (e) {
      return null // tainted by cross-origin content
    }
  }

  function sampleCanvases() {
    if (!active) return
    canvases.forEach(function (el) {
      if (!el.isConnected) { canvases.delete(el); return }
      var id = nodeIds.get(el)
      if (!id || isInsideBlocked(el)) return
      if (el.tagName === 'VIDEO' && el.paused && lastFrames.has(el)) return
      var frame = captureFrame(el)
      if (!frame || frame === lastFrames.get(el)) return
      lastFrames.set(el, frame)
      emit('canvas', { id: id, data: frame })
    })
  }

  // ---------------------------------------------------------------- DOM serialization

  function serializeNode(n) {
    var id = nextNodeId++
    nodeIds.set(n, id)
    switch (n.nodeType) {
      case 9:
      case 11: {
        var root = { id: id, type: n.nodeType, childNodes: serializeChildren(n) }
        var adopted = serializeAdopted(n)
        if (adopted) root.adopted = adopted
        observeRoot(n)
        return root
      }
      case 10: return { id: id, type: 10, name: n.name || 'html', publicId: n.publicId || '', systemId: n.systemId || '' }
      case 1: return serializeElement(n, id)
      case 3:
      case 4: return { id: id, type: 3, text: textValue(n) }
      // Comments, processing instructions etc. still get an id so sibling positions stay valid.
      default: return { id: id, type: 8, text: '' }
    }
  }

  function serializeChildren(n) {
    var out = []
    for (var c = n.firstChild; c; c = c.nextSibling) out.push(serializeNode(c))
    return out
  }

  function textValue(n) {
    var p = n.parentNode
    var tag = p && p.nodeName
    if (tag === 'SCRIPT') return ''
    if (tag === 'STYLE') return absCss(n.nodeValue)
    if (tag === 'TEXTAREA' && shouldMaskInput(p)) return maskString(n.nodeValue)
    if (p && closestMatch(p, config.maskTextSelector)) return maskString(n.nodeValue)
    return n.nodeValue
  }

  function serializeAttr(el, tag, name, value) {
    if (DROP_ATTR_RE.test(name) || name === 'autofocus') return undefined
    if (tag === 'input' && name === 'value') {
      var type = (el.getAttribute('type') || '').toLowerCase()
      if (type === 'hidden') return ''
      return shouldMaskInput(el) ? new Array(value.length + 1).join('*') : value
    }
    if (name === 'srcset') return absSrcset(value)
    if (name === 'style') return absCss(value)
    if (URL_ATTRS[name]) return absUrl(value)
    return value
  }

  function serializeElement(el, id) {
    var tag = el.tagName.toLowerCase()
    var node = { id: id, type: 1, tag: tag, attrs: {} }
    if (el.namespaceURI === SVG_NS) node.svg = 1

    if (matches(el, config.blockSelector)) {
      blockedNodes.add(el)
      var r = el.getBoundingClientRect()
      node.blocked = 1
      node.attrs.style = 'display:' + (window.getComputedStyle(el).display || 'block') +
        ';width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) + 'px'
      node.childNodes = []
      return node
    }

    var attrs = el.attributes
    for (var i = 0; i < attrs.length; i++) {
      var v = serializeAttr(el, tag, attrs[i].name, attrs[i].value)
      if (v !== undefined) node.attrs[attrs[i].name] = v
    }

    if (tag === 'input') {
      var type = (el.type || '').toLowerCase()
      if (type === 'checkbox' || type === 'radio') {
        if (el.checked) node.attrs.checked = ''
        else delete node.attrs.checked
      } else if (type !== 'file' && type !== 'hidden') {
        node.attrs.value = inputValue(el)
      }
    } else if (tag === 'textarea' || tag === 'select') {
      node.value = inputValue(el)
    }

    // CSS-in-JS libraries inject rules through the CSSOM, leaving the <style> text empty.
    if (tag === 'style' && !(el.textContent || '').trim()) {
      var css = sheetText(el.sheet)
      if (css) node.cssText = css
    }
    if (tag === 'link' && config.inlineStylesheets && STYLESHEET_RE.test(el.rel || '')) {
      var linked = sheetText(el.sheet)
      if (linked != null) node.cssText = linked
    }

    if (tag === 'iframe' || tag === 'frame') {
      node.childNodes = []
      var doc = config.recordIframes && frameDoc(el)
      if (doc) node.doc = serializeNode(doc)
      return node
    }

    if ((tag === 'video' || tag === 'audio') && config.recordMedia) node.media = mediaState(el)
    if (config.recordCanvas && (tag === 'canvas' || (tag === 'video' && !replayableMedia(el)))) {
      canvases.add(el)
      var frame = captureFrame(el)
      if (frame) {
        node.canvas = frame
        lastFrames.set(el, frame)
      }
    }

    node.childNodes = serializeChildren(el)
    var shadow = el.shadowRoot || closedRoots.get(el)
    if (shadow) node.shadow = serializeNode(shadow)
    return node
  }

  function takeFullSnapshot() {
    if (!active || !config.recordDom) return
    if (observer) observer.takeRecords()
    nodeIds = new WeakMap()
    blockedNodes = new WeakSet()
    sheetsSent = new WeakSet()
    nextNodeId = 1
    emit('snapshot', {
      node: serializeNode(document),
      href: location.href,
      width: window.innerWidth,
      height: window.innerHeight,
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }
    })
  }

  // ---------------------------------------------------------------- DOM mutations

  var MUTATION_OPTIONS = { childList: true, subtree: true, attributes: true, characterData: true }

  // Documents (main + iframes) and shadow roots each need their own observation and listeners.
  function observeRoot(root) {
    if (observer) {
      try { observer.observe(root, MUTATION_OPTIONS) } catch (e) { /* ignore */ }
    }
    addRootListeners(root)
  }

  function hasAncestorIn(n, set) {
    for (var p = parentOf(n); p; p = parentOf(p)) if (set.has(p)) return true
    return false
  }

  function onMutations(records) {
    if (!active) return
    var added = new Set()
    var removes = []
    var attrTargets = new Map()
    var textTargets = new Set()

    for (var r = 0; r < records.length; r++) {
      var rec = records[r]
      if (rec.type === 'childList') {
        if (isInsideBlocked(rec.target)) continue
        for (var i = 0; i < rec.removedNodes.length; i++) {
          var removed = rec.removedNodes[i]
          var rid = nodeIds.get(removed)
          if (rid) removes.push({ id: rid })
          added.delete(removed)
        }
        for (var j = 0; j < rec.addedNodes.length; j++) added.add(rec.addedNodes[j])
      } else if (rec.type === 'attributes') {
        if (!nodeIds.has(rec.target)) continue
        var names = attrTargets.get(rec.target)
        if (!names) attrTargets.set(rec.target, names = new Set())
        names.add(rec.attributeName)
      } else if (rec.type === 'characterData') {
        if (nodeIds.has(rec.target)) textTargets.add(rec.target)
      }
    }

    // Only the roots of newly added subtrees are serialized; descendants come along with them.
    var pending = new Set()
    added.forEach(function (n) {
      if (n.isConnected && !hasAncestorIn(n, added) && !isInsideBlocked(n.parentNode)) pending.add(n)
    })

    // Emit adds so that each node's next sibling already exists on the replay side.
    var adds = []
    var needFull = false
    while (pending.size) {
      var progressed = false
      pending.forEach(function (n) {
        var next = n.nextSibling
        if (next && pending.has(next)) return
        var parentId = nodeIds.get(n.parentNode)
        var nextId = next ? nodeIds.get(next) : null
        pending.delete(n)
        if (!parentId || (next && !nextId)) { needFull = true; return }
        adds.push({ parentId: parentId, nextId: nextId, node: serializeNode(n) })
        progressed = true
      })
      if (!progressed) { needFull = needFull || pending.size > 0; break }
    }

    // Fall back to a full snapshot, but never more than once every 5s to avoid snapshot storms.
    if (needFull && now() - lastFallbackSnapshot > 5000) {
      debug('mutation ordering failed, taking full snapshot')
      lastFallbackSnapshot = now()
      takeFullSnapshot()
      return
    }

    var attrs = []
    attrTargets.forEach(function (names, el) {
      if (!el.isConnected || added.has(el) || hasAncestorIn(el, added) || isInsideBlocked(el)) return
      var tag = el.tagName.toLowerCase()
      var changes = {}
      var any = false
      names.forEach(function (name) {
        var v = el.getAttribute(name)
        if (v === null) {
          if (!DROP_ATTR_RE.test(name)) { changes[name] = null; any = true }
        } else {
          var s = serializeAttr(el, tag, name, v)
          if (s !== undefined) { changes[name] = s; any = true }
        }
      })
      if (any) attrs.push({ id: nodeIds.get(el), attrs: changes })
    })

    var texts = []
    textTargets.forEach(function (n) {
      if (!n.isConnected || added.has(n) || hasAncestorIn(n, added) || isInsideBlocked(n)) return
      texts.push({ id: nodeIds.get(n), text: textValue(n) })
    })

    if (!adds.length && !removes.length && !attrs.length && !texts.length) return
    var data = {}
    if (adds.length) data.adds = adds
    if (removes.length) data.removes = removes
    if (attrs.length) data.attrs = attrs
    if (texts.length) data.texts = texts
    emit('mutation', data)
  }

  function startDomRecording() {
    if (window.MutationObserver) observer = new MutationObserver(safe(onMutations))
    patchShadowDom()
    patchCssom()
    if (config.recordCanvas) patchCanvasContext()
    takeFullSnapshot()
    // The parser can grow text nodes without firing mutations, so re-snapshot once parsing ends.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', safe(takeFullSnapshot))
    }
    if (config.recordCanvas) {
      canvasTimer = setInterval(safe(sampleCanvases), Math.max(50, Math.round(1000 / config.canvasFps)))
    }
  }

  function patchShadowDom() {
    if (patched.shadow || !window.Element || !Element.prototype.attachShadow) return
    patched.shadow = true
    var attachShadow = Element.prototype.attachShadow
    Element.prototype.attachShadow = function () {
      var root = attachShadow.apply(this, arguments)
      try {
        if (root.mode === 'closed') closedRoots.set(this, root)
        // A host that is already recorded gets its (still empty) root now; children follow as mutations.
        var hostId = active && nodeIds.get(this)
        if (hostId && !isInsideBlocked(this)) emit('shadow', { hostId: hostId, node: serializeNode(root) })
      } catch (e) { /* ignore */ }
      return root
    }
  }

  function patchCssom() {
    if (patched.cssom || !window.CSSStyleSheet) return
    patched.cssom = true
    var proto = CSSStyleSheet.prototype

    function ruleTarget(sheet) {
      var owner = sheet.ownerNode
      if (owner) {
        var id = nodeIds.get(owner)
        return id && !isInsideBlocked(owner) ? { id: id } : null
      }
      var sheetId = sheetIds.get(sheet)
      return sheetId ? { sheetId: sheetId } : null
    }

    var insertRule = proto.insertRule
    proto.insertRule = function (rule) {
      var result = insertRule.apply(this, arguments)
      try {
        var target = active && ruleTarget(this)
        if (target) {
          target.rule = absCss(String(rule), this.href || undefined)
          target.index = result
          emit('style', target)
        }
      } catch (e) { /* ignore */ }
      return result
    }
    var deleteRule = proto.deleteRule
    proto.deleteRule = function (index) {
      var result = deleteRule.apply(this, arguments)
      try {
        var target = active && ruleTarget(this)
        if (target) {
          target.remove = index
          emit('style', target)
        }
      } catch (e) { /* ignore */ }
      return result
    }
    if (proto.replaceSync) {
      var replaceSync = proto.replaceSync
      proto.replaceSync = function (text) {
        var result = replaceSync.apply(this, arguments)
        try { notifySheet(this, { css: absCss(String(text)) }) } catch (e) { /* ignore */ }
        return result
      }
    }
    if (proto.replace) {
      var replace = proto.replace
      proto.replace = function () {
        var sheet = this
        var promise = replace.apply(this, arguments)
        promise.then(function () {
          try { notifySheet(sheet, { css: sheetText(sheet) || '' }) } catch (e) { /* ignore */ }
        }, function () {})
        return promise
      }
    }

    // document.adoptedStyleSheets = [...] / shadowRoot.adoptedStyleSheets = [...]
    ;[window.Document && Document.prototype, window.ShadowRoot && ShadowRoot.prototype].forEach(function (p) {
      var desc = p && Object.getOwnPropertyDescriptor(p, 'adoptedStyleSheets')
      if (!desc || !desc.set || !desc.configurable) return
      Object.defineProperty(p, 'adoptedStyleSheets', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (value) {
          desc.set.call(this, value)
          try {
            var id = active && nodeIds.get(this)
            if (id && !isInsideBlocked(this)) emit('adopted', { id: id, sheets: serializeAdopted(this) || [] })
          } catch (e) { /* ignore */ }
        }
      })
    })
  }

  // WebGL clears its drawing buffer after each frame unless asked not to, which makes it unreadable.
  function patchCanvasContext() {
    if (patched.canvas || !window.HTMLCanvasElement) return
    patched.canvas = true
    var getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, attributes) {
      if (active && /webgl/i.test(String(type))) {
        return getContext.call(this, type, Object.assign({}, attributes, { preserveDrawingBuffer: true }))
      }
      return getContext.apply(this, arguments)
    }
  }

  // ---------------------------------------------------------------- interactions

  var scrollPending = new Map()
  var scrollTimer = null
  var lastMove = 0
  var resizeTimer = null

  // Composed events reach several root listeners; record each event once.
  function claim(e) {
    if (handledEvents.has(e)) return false
    handledEvents.add(e)
    return true
  }

  function onInput(e) {
    if (!active || handledEvents.has(e)) return
    var t = realTarget(e)
    var id = t && nodeIds.get(t)
    // Inside a closed shadow root the document only sees the host; the root's own listener records it.
    if (!id || isInsideBlocked(t) || !('value' in t)) return
    claim(e)
    var type = (t.type || '').toLowerCase()
    if (type === 'checkbox' || type === 'radio') emit('input', { id: id, checked: !!t.checked })
    else if (type !== 'file') emit('input', { id: id, value: inputValue(t) })
  }

  function onScroll(e) {
    if (!active) return
    var target = e.target
    if (target && target.nodeType !== 1 && target.nodeType !== 9) target = target.document || document
    var id = nodeIds.get(target)
    if (!id) return
    scrollPending.set(target, id)
    if (!scrollTimer) scrollTimer = setTimeout(safe(flushScroll), 100)
  }

  function flushScroll() {
    scrollTimer = null
    scrollPending.forEach(function (id, target) {
      if (target.nodeType === 9) {
        var win = target.defaultView || window
        emit('scroll', { id: id, x: Math.round(win.scrollX), y: Math.round(win.scrollY) })
      } else {
        emit('scroll', { id: id, x: Math.round(target.scrollLeft), y: Math.round(target.scrollTop) })
      }
    })
    scrollPending.clear()
  }

  function pointerOffset(e) {
    var t = e.target
    var doc = t && (t.ownerDocument || (t.nodeType === 9 ? t : null))
    return doc && doc !== document ? frameOffset(doc) : { x: 0, y: 0 }
  }

  function onMove(e) {
    var t = now()
    if (!active || t - lastMove < 50) return
    lastMove = t
    var p = e.touches ? e.touches[0] : e
    if (!p) return
    var off = pointerOffset(e)
    emit('mouse', { x: Math.round(p.clientX + off.x), y: Math.round(p.clientY + off.y) })
  }

  function onClick(e) {
    if (!active || !claim(e)) return
    var target = realTarget(e)
    var label = elementLabel(target)
    var data = { id: nodeIds.get(target) || null, selector: label.selector, text: label.text }
    // Keyboard-activated and programmatic clicks (detail 0) have no real pointer position.
    if (e.detail !== 0) {
      var off = pointerOffset(e)
      data.x = Math.round(e.clientX + off.x)
      data.y = Math.round(e.clientY + off.y)
    }
    emit('click', data)
  }

  function onMedia(e) {
    if (!active) return
    var t = e.target
    if (!t || (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO')) return
    var id = nodeIds.get(t)
    if (!id || isInsideBlocked(t)) return
    var state = mediaState(t)
    state.id = id
    state.action = e.type
    emit('media', state)
  }

  // Load events don't bubble but are visible to capturing listeners: re-record iframes and linked CSS.
  function onResourceLoad(e) {
    if (!active) return
    var t = e.target
    if (!t || t.nodeType !== 1) return
    var id = nodeIds.get(t)
    if (!id || isInsideBlocked(t)) return
    if (t.tagName === 'IFRAME' || t.tagName === 'FRAME') {
      var doc = config.recordIframes && frameDoc(t)
      if (doc) emit('iframe', { id: id, node: serializeNode(doc) })
    } else if (t.tagName === 'LINK' && config.inlineStylesheets && STYLESHEET_RE.test(t.rel || '')) {
      var css = sheetText(t.sheet)
      if (css != null) emit('style', { id: id, css: css })
    }
  }

  function onResize() {
    if (resizeTimer) return
    resizeTimer = setTimeout(safe(function () {
      resizeTimer = null
      emit('viewport', { width: window.innerWidth, height: window.innerHeight })
    }), 200)
  }

  function addRootListeners(root) {
    if (listenedRoots.has(root) || !config) return
    listenedRoots.add(root)
    var opts = { capture: true, passive: true }
    var isDocument = root.nodeType === 9
    root.addEventListener('load', safe(onResourceLoad), opts)
    if (config.recordMedia) {
      MEDIA_EVENTS.forEach(function (type) { root.addEventListener(type, safe(onMedia), opts) })
    }
    if (config.recordInteractions) {
      root.addEventListener('input', safe(onInput), opts)
      root.addEventListener('change', safe(onInput), opts)
      root.addEventListener('scroll', safe(onScroll), opts)
      if (isDocument) {
        root.addEventListener('mousemove', safe(onMove), opts)
        root.addEventListener('touchmove', safe(onMove), opts)
        root.addEventListener('click', safe(onClick), opts)
      }
    }
  }

  // ---------------------------------------------------------------- console + errors

  function serializeError(err) {
    if (!err) return { message: String(err) }
    return {
      name: err.name || 'Error',
      message: String(err.message != null ? err.message : err),
      stack: err.stack ? String(err.stack).slice(0, 5000) : undefined
    }
  }

  function serializeValue(v, depth, seen) {
    var type = typeof v
    if (v === null || type === 'boolean') return v
    if (type === 'number') return isFinite(v) ? v : String(v)
    if (type === 'undefined') return 'undefined'
    if (type === 'string') return truncate(v, 2000)
    if (type === 'bigint') return v.toString() + 'n'
    if (type === 'symbol') return v.toString()
    if (type === 'function') return '[Function ' + (v.name || 'anonymous') + ']'
    if (v instanceof Error) return { __error: serializeError(v) }
    if (typeof Node !== 'undefined' && v instanceof Node) return '[' + describeEl(v) + ']'
    if (v === window) return '[Window]'
    if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString()
    if (depth >= 3) return Array.isArray(v) ? '[Array(' + v.length + ')]' : '[Object]'
    if (seen.has(v)) return '[Circular]'
    seen.add(v)
    if (v instanceof Map) v = Array.from(v.entries())
    else if (v instanceof Set) v = Array.from(v)
    if (Array.isArray(v)) {
      var arr = v.slice(0, 100).map(function (x) { return serializeValue(x, depth + 1, seen) })
      if (v.length > 100) arr.push('… ' + (v.length - 100) + ' more')
      return arr
    }
    var out = {}
    var count = 0
    try {
      for (var k in v) {
        if (count++ >= 50) { out['…'] = 'more keys'; break }
        try { out[k] = serializeValue(v[k], depth + 1, seen) } catch (e) { out[k] = '[Unreadable]' }
      }
    } catch (e) { /* exotic object */ }
    return out
  }

  function patchConsole() {
    if (patched.console || !window.console) return
    patched.console = true
    config.consoleLevels.forEach(function (level) {
      var orig = console[level]
      if (typeof orig !== 'function') return
      console[level] = function () {
        if (active && !inConsoleHook) {
          inConsoleHook = true
          try {
            var args = [].map.call(arguments, function (a) { return serializeValue(a, 0, new WeakSet()) })
            var data = { level: level, args: args }
            if (level === 'error' || level === 'warn') {
              var stack = new Error().stack
              if (stack) data.stack = String(stack).split('\n').slice(2).join('\n').slice(0, 3000)
            }
            emit('console', data)
          } catch (e) { /* ignore */ }
          inConsoleHook = false
        }
        return orig.apply(this, arguments)
      }
    })
  }

  function patchErrors() {
    if (patched.errors) return
    patched.errors = true
    window.addEventListener('error', safe(function (e) {
      if (!active) return
      var target = e.target
      if (target && target !== window && target.nodeType === 1) {
        emit('error', { kind: 'resource', message: 'Failed to load ' + target.tagName.toLowerCase(), url: absUrl(target.src || target.href) })
        return
      }
      var err = serializeError(e.error || { message: e.message })
      err.kind = 'uncaught'
      err.source = e.filename
      err.line = e.lineno
      err.column = e.colno
      emit('error', err)
    }), true)
    window.addEventListener('unhandledrejection', safe(function (e) {
      if (!active) return
      var reason = e.reason
      var err = reason instanceof Error ? serializeError(reason) : { name: 'UnhandledRejection', message: JSON.stringify(serializeValue(reason, 0, new WeakSet())) }
      err.kind = 'unhandledrejection'
      emit('error', err)
    }))
  }

  // ---------------------------------------------------------------- network

  function shouldIgnoreUrl(url) {
    if (!url) return true
    if (config.endpoint && url.indexOf(config.endpoint) === 0) return true
    for (var i = 0; i < config.ignoreUrls.length; i++) {
      var rule = config.ignoreUrls[i]
      if (rule instanceof RegExp ? rule.test(url) : url.indexOf(rule) !== -1) return true
    }
    return false
  }

  function redact(name, value) {
    return config.sensitiveHeaders.indexOf(String(name).toLowerCase()) !== -1 ? '[redacted]' : String(value)
  }

  function headersToObject(h) {
    var out = {}
    if (!h) return out
    try {
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach(function (v, k) { out[k] = redact(k, v) })
      else if (Array.isArray(h)) h.forEach(function (pair) { out[pair[0]] = redact(pair[0], pair[1]) })
      else Object.keys(h).forEach(function (k) { out[k] = redact(k, h[k]) })
    } catch (e) { /* ignore */ }
    return out
  }

  function parseRawHeaders(raw) {
    var out = {}
    String(raw || '').trim().split(/[\r\n]+/).forEach(function (line) {
      var i = line.indexOf(':')
      if (i > 0) {
        var k = line.slice(0, i).trim().toLowerCase()
        out[k] = redact(k, line.slice(i + 1).trim())
      }
    })
    return out
  }

  function bodyPreview(body) {
    if (body == null || !config.networkBodies) return undefined
    if (typeof body === 'string') return truncate(body)
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return truncate(body.toString())
    if (typeof FormData !== 'undefined' && body instanceof FormData) return '[FormData]'
    if (typeof Blob !== 'undefined' && body instanceof Blob) return '[Blob ' + body.size + ' bytes]'
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return '[Binary ' + body.byteLength + ' bytes]'
    return '[' + Object.prototype.toString.call(body).slice(8, -1) + ']'
  }

  function isTextual(contentType) {
    return /json|text\/|xml|javascript|graphql|x-www-form-urlencoded/i.test(contentType || '') && !/event-stream/i.test(contentType)
  }

  function emitNetwork(entry) {
    entry.slow = entry.duration >= config.slowRequestThreshold
    emit('network', entry, entry.start)
  }

  function patchFetch() {
    if (patched.fetch || !window.fetch) return
    patched.fetch = true
    var pageFetch = window.fetch
    window.fetch = function (input, init) {
      var promise = pageFetch.apply(window, arguments)
      if (!active || !config.recordNetwork) return promise
      var entry
      try {
        var isRequest = typeof Request !== 'undefined' && input instanceof Request
        var url = absUrl(isRequest ? input.url : String(input))
        if (shouldIgnoreUrl(url)) return promise
        entry = {
          kind: 'fetch',
          method: String((init && init.method) || (isRequest && input.method) || 'GET').toUpperCase(),
          url: url,
          start: now(),
          requestHeaders: headersToObject((init && init.headers) || (isRequest ? input.headers : null)),
          requestBody: init ? bodyPreview(init.body) : undefined
        }
      } catch (e) {
        return promise
      }
      promise.then(safe(function (res) {
        entry.duration = now() - entry.start
        entry.status = res.status
        entry.statusText = res.statusText
        entry.responseHeaders = headersToObject(res.headers)
        var ct = res.headers.get('content-type') || ''
        var size = +res.headers.get('content-length') || 0
        if (config.networkBodies && res.type !== 'opaque' && isTextual(ct) && size < 1000000) {
          res.clone().text().then(function (text) {
            entry.responseBody = truncate(text)
            emitNetwork(entry)
          }, function () { emitNetwork(entry) })
        } else {
          emitNetwork(entry)
        }
      }), safe(function (err) {
        entry.duration = now() - entry.start
        entry.status = 0
        entry.error = String((err && err.message) || err)
        emitNetwork(entry)
      }))
      return promise
    }
  }

  function patchXhr() {
    if (patched.xhr || !window.XMLHttpRequest) return
    patched.xhr = true
    var proto = XMLHttpRequest.prototype
    var open = proto.open
    var send = proto.send
    var setRequestHeader = proto.setRequestHeader

    proto.open = function (method, url) {
      try { this.__logit = { kind: 'xhr', method: String(method || 'GET').toUpperCase(), url: absUrl(String(url)), requestHeaders: {} } } catch (e) { /* ignore */ }
      return open.apply(this, arguments)
    }
    proto.setRequestHeader = function (name, value) {
      try { if (this.__logit) this.__logit.requestHeaders[name] = redact(name, value) } catch (e) { /* ignore */ }
      return setRequestHeader.apply(this, arguments)
    }
    proto.send = function (body) {
      var entry = this.__logit
      try {
        if (entry && active && config.recordNetwork && !shouldIgnoreUrl(entry.url)) {
          var xhr = this
          entry.start = now()
          entry.requestBody = bodyPreview(body)
          xhr.addEventListener('loadend', safe(function () {
            entry.duration = now() - entry.start
            entry.status = xhr.status
            entry.statusText = xhr.statusText
            entry.responseHeaders = parseRawHeaders(xhr.getAllResponseHeaders())
            if (xhr.status === 0) entry.error = 'Network error or request aborted'
            if (config.networkBodies && isTextual(xhr.getResponseHeader('content-type'))) {
              if (xhr.responseType === '' || xhr.responseType === 'text') entry.responseBody = truncate(xhr.responseText)
              else if (xhr.responseType === 'json') entry.responseBody = truncate(JSON.stringify(xhr.response))
            }
            emitNetwork(entry)
          }))
        }
      } catch (e) { /* ignore */ }
      return send.apply(this, arguments)
    }
  }

  // ---------------------------------------------------------------- performance + navigation

  function recordPerformance() {
    if (!window.performance) return
    var report = safe(function () {
      var data = {}
      var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0]
      if (nav) {
        data.ttfb = Math.round(nav.responseStart)
        data.domContentLoaded = Math.round(nav.domContentLoadedEventEnd)
        data.load = Math.round(nav.loadEventEnd)
        data.transferSize = nav.transferSize
        data.navigationType = nav.type
      } else if (performance.timing) {
        var t = performance.timing
        data.ttfb = t.responseStart - t.navigationStart
        data.domContentLoaded = t.domContentLoadedEventEnd - t.navigationStart
        data.load = t.loadEventEnd - t.navigationStart
      }
      if (performance.getEntriesByType) {
        performance.getEntriesByType('paint').forEach(function (p) {
          if (p.name === 'first-contentful-paint') data.fcp = Math.round(p.startTime)
          if (p.name === 'first-paint') data.fp = Math.round(p.startTime)
        })
      }
      emit('perf', data)
    })
    if (document.readyState === 'complete') setTimeout(report, 0)
    else window.addEventListener('load', function () { setTimeout(report, 0) })

    // Largest Contentful Paint is final once the page is hidden.
    try {
      var lcp = 0
      new PerformanceObserver(function (list) {
        var entries = list.getEntries()
        if (entries.length) lcp = entries[entries.length - 1].startTime
      }).observe({ type: 'largest-contentful-paint', buffered: true })
      var sent = false
      document.addEventListener('visibilitychange', safe(function () {
        if (document.visibilityState === 'hidden' && lcp && !sent) {
          sent = true
          emit('perf', { lcp: Math.round(lcp) })
        }
      }))
    } catch (e) { /* unsupported */ }
  }

  function patchHistory() {
    if (patched.history) return
    patched.history = true
    ;['pushState', 'replaceState'].forEach(function (method) {
      var orig = history[method]
      if (typeof orig !== 'function') return
      history[method] = function () {
        var result = orig.apply(this, arguments)
        if (active) emit('nav', { href: location.href, kind: method })
        return result
      }
    })
    window.addEventListener('popstate', safe(function () { if (active) emit('nav', { href: location.href, kind: 'popstate' }) }))
    window.addEventListener('hashchange', safe(function () { if (active) emit('nav', { href: location.href, kind: 'hashchange' }) }))
  }

  function collectMeta() {
    var tz
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } catch (e) { /* ignore */ }
    return {
      href: location.href,
      referrer: document.referrer,
      title: document.title,
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio || 1 },
      timezone: tz,
      sdkVersion: VERSION,
      pageId: pageId
    }
  }

  // ---------------------------------------------------------------- session

  function loadSession() {
    var s = null
    try { s = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) || 'null') } catch (e) { /* storage blocked */ }
    if (!s || s.appId !== config.appId || !ID_RE.test(s.id || '') || now() - s.lastActive > config.sessionTimeout) {
      s = { id: uid(), appId: config.appId, sampled: Math.random() < config.sampleRate, lastActive: now() }
    }
    identity = s.user || null
    sessionState = s
    saveSession()
  }

  function saveSession() {
    try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(sessionState)) } catch (e) { /* storage blocked */ }
  }

  function touchSession() {
    if (!sessionState) return
    sessionState.lastActive = now()
    saveSession()
  }

  // ---------------------------------------------------------------- transport

  function scheduleFlush(delay) {
    if (flushScheduled) return
    flushScheduled = true
    setTimeout(function () {
      flushScheduled = false
      flush()
    }, delay)
  }

  function buildPayload(events) {
    return JSON.stringify({
      v: 1, sdk: VERSION, appId: config.appId, sessionId: sessionState.id, pageId: pageId,
      seq: seq++, user: identity, sentAt: now(), events: events
    })
  }

  function postOptions(body, keepalive) {
    return {
      method: 'POST',
      body: body,
      // text/plain keeps this a CORS "simple request" (no preflight); the server parses JSON anyway.
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      credentials: 'omit',
      keepalive: !!keepalive && body.length < 60000
    }
  }

  // Page is going away: fire-and-forget everything that is buffered.
  function flushOnUnload() {
    if (!active || !config.endpoint || !buffer.length) return
    touchSession()
    while (buffer.length) {
      var body = buildPayload(buffer.splice(0, config.maxBatchSize))
      var sent = false
      if (body.length < 60000 && navigator.sendBeacon) {
        try { sent = navigator.sendBeacon(config.endpoint, new Blob([body], { type: 'text/plain' })) } catch (e) { /* ignore */ }
      }
      if (!sent && nativeFetch) {
        try { nativeFetch(config.endpoint, postOptions(body, true)).catch(function () {}) } catch (e) { /* ignore */ }
      }
    }
  }

  function flush() {
    if (!config || !config.endpoint || !nativeFetch || !buffer.length) return inflight || Promise.resolve()
    if (inflight) return inflight
    if (now() < backoffUntil) return Promise.resolve()

    var events = buffer.splice(0, config.maxBatchSize)
    var body = buildPayload(events)
    touchSession()
    inflight = nativeFetch(config.endpoint, postOptions(body, false)).then(function (res) {
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status)
      if (!res.ok) debug('batch rejected with status', res.status) // 4xx: retrying would not help
      failures = 0
    }).catch(function (err) {
      failures++
      backoffUntil = now() + Math.min(60000, 1000 * Math.pow(2, failures))
      debug('flush failed', err, 'attempt', failures)
      if (failures <= config.maxRetries) {
        buffer = events.concat(buffer)
        trimBuffer()
      } else {
        failures = 0
      }
    }).then(function () {
      inflight = null
      if (buffer.length >= config.maxBatchSize) scheduleFlush(0)
    })
    return inflight
  }

  // Resolves once everything buffered has been sent (or sending is backing off).
  function flushAll() {
    return flush().then(function () {
      if (buffer.length && !inflight && now() >= backoffUntil && config.endpoint) return flushAll()
    })
  }

  // ---------------------------------------------------------------- public API

  function init(options) {
    if (active) { debug('already initialized'); return LogIt }
    options = options || {}
    if (!options.appId || !ID_RE.test(String(options.appId))) {
      warn('init() requires an appId matching ' + ID_RE)
      return LogIt
    }
    config = Object.assign({}, DEFAULTS, options)
    if (config.maskInputTypes.indexOf('password') === -1) config.maskInputTypes = config.maskInputTypes.concat('password')
    if (config.endpoint) config.endpoint = absUrl(config.endpoint)

    loadSession()
    if (!sessionState.sampled) { debug('session not sampled'); return LogIt }

    pageId = uid()
    seq = 0
    active = true

    emit('meta', collectMeta())
    if (identity) emit('identify', identity)
    addRootListeners(document)
    if (config.recordInteractions) window.addEventListener('resize', safe(onResize), { passive: true })
    if (config.recordDom) startDomRecording()
    if (config.recordConsole) patchConsole()
    if (config.recordErrors) patchErrors()
    if (config.recordNetwork) { patchFetch(); patchXhr() }
    if (config.recordPerformance) recordPerformance()
    patchHistory()

    if (config.endpoint) {
      flushTimer = setInterval(function () { flush() }, config.flushInterval)
      if (!patched.unload) {
        patched.unload = true
        document.addEventListener('visibilitychange', safe(function () {
          if (document.visibilityState === 'hidden') flushOnUnload()
        }))
        window.addEventListener('pagehide', safe(flushOnUnload))
      }
    }
    debug('recording session', sessionState.id)
    return LogIt
  }

  function log(message, data, level) {
    emit('custom', { kind: 'log', level: level || 'info', message: String(message), data: data === undefined ? undefined : serializeValue(data, 0, new WeakSet()) })
  }

  function track(name, properties) {
    emit('custom', { kind: 'track', name: String(name), data: properties === undefined ? undefined : serializeValue(properties, 0, new WeakSet()) })
  }

  function identify(userId, traits) {
    if (!sessionState) return
    identity = { id: String(userId).slice(0, 200), traits: traits ? serializeValue(traits, 0, new WeakSet()) : undefined }
    sessionState.user = identity
    saveSession()
    emit('identify', identity)
  }

  function stop() {
    if (!active) return
    flushOnUnload()
    active = false
    if (observer) { observer.disconnect(); observer = null }
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
    if (canvasTimer) { clearInterval(canvasTimer); canvasTimer = null }
  }

  function getSessionURL() {
    if (!sessionState || !config) return null
    var base = config.viewerUrl
    if (!base && config.endpoint) base = new URL(config.endpoint).origin + '/viewer/'
    if (!base) return null
    return base + '#/session/' + encodeURIComponent(config.appId) + '/' + encodeURIComponent(sessionState.id)
  }

  var LogIt = {
    __loaded: true,
    version: VERSION,
    init: safe(init),
    log: safe(log),
    track: safe(track),
    identify: safe(identify),
    flush: function () { try { return flushAll() } catch (e) { return Promise.resolve() } },
    stop: safe(stop),
    takeSnapshot: safe(takeFullSnapshot),
    getSessionId: function () { return sessionState && active ? sessionState.id : null },
    getSessionURL: safe(getSessionURL),
    getEvents: function () { return buffer.slice() },
    isRecording: function () { return active }
  }

  window.LogIt = LogIt
  // Backwards compatible with the original prototype API.
  window.initLogIt = function (appId, options) { return LogIt.init(Object.assign({ appId: appId }, options)) }

  // Zero-config install: <script src=".../sdk/logit.js" data-app-id="my-app"></script>
  var script = document.currentScript
  if (script && script.getAttribute('data-app-id')) {
    var endpoint = script.getAttribute('data-endpoint')
    if (!endpoint && script.src) endpoint = new URL('/api/ingest', script.src).href
    LogIt.init({
      appId: script.getAttribute('data-app-id'),
      endpoint: endpoint,
      maskAllInputs: script.hasAttribute('data-mask-all-inputs'),
      recordCanvas: script.hasAttribute('data-record-canvas'),
      debug: script.hasAttribute('data-debug')
    })
  }
})(typeof window !== 'undefined' ? window : undefined)
