/*!
 * LogIt replayer
 * Rebuilds a recorded session inside a sandboxed iframe (scripts never run) and plays it back.
 *
 *   const player = new LogItReplayer(containerEl, events, {
 *     speed: 1,
 *     skipInactive: true,
 *     resolveUrl: url => archivedUrlFor(url) || url   // optional: serve archived assets
 *   })
 *   player.on('time', ms => ...); player.play(); player.seek(ms); player.setSpeed(2)
 */
(function (root) {
  'use strict'

  var SVG_NS = 'http://www.w3.org/2000/svg'
  var EMBED_TAGS = { iframe: 1, frame: 1, object: 1, embed: 1 }
  var URL_ATTRS = { href: 1, src: 1, poster: 1, background: 1, 'xlink:href': 1 }
  var CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
  var CURSOR_SVG = '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M2 1l14 8.5-6.2 1.3L13 18l-2.6 1.1-3.2-7.1L2 16z" fill="#111" stroke="#fff" stroke-width="1.2"/></svg>'

  function LogItReplayer(container, events, options) {
    this.container = container
    this.options = Object.assign({ speed: 1, skipInactive: true, inactiveThreshold: 4000, resolveUrl: null }, options)
    // Network events are stamped with their start time, so order by time, keeping arrival order for ties.
    this.events = (events || []).map(function (e, i) { return { e: e, i: i } })
      .sort(function (a, b) { return a.e.t - b.e.t || a.i - b.i })
      .map(function (x) { return x.e })
    this.startTime = this.events.length ? this.events[0].t : 0
    this.endTime = this.events.length ? this.events[this.events.length - 1].t : 0
    this.duration = this.endTime - this.startTime
    this.speed = this.options.speed
    this.current = 0
    this.index = 0
    this.playing = false
    this.listeners = {}
    this.vw = 1280
    this.vh = 720
    this._pendingCanvas = null      // while seeking: canvas id -> latest frame
    this._resetState()
    this._tick = this._tick.bind(this)
    this._buildStage()
    this.seek(0)
  }

  LogItReplayer.prototype.on = function (name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn)
    return this
  }

  LogItReplayer.prototype._emit = function (name, arg) {
    (this.listeners[name] || []).forEach(function (fn) {
      try { fn(arg) } catch (e) { console.error(e) }
    })
  }

  LogItReplayer.prototype._resetState = function () {
    this.nodes = new Map()          // recorded node id -> live node (element, text, document, shadow root)
    this.sheetDefs = new Map()      // constructed sheet id -> css text
    this.sheetInstances = new Map() // constructed sheet id -> [CSSStyleSheet per replay document]
    this.media = new Map()          // media element -> { state, offset } of its last recorded event
    this._pendingFrames = []        // iframes whose document can only be written once attached
  }

  // ---------------------------------------------------------------- stage

  LogItReplayer.prototype._buildStage = function () {
    var c = this.container
    c.textContent = ''
    var wrapper = document.createElement('div')
    wrapper.className = 'logit-replay'
    wrapper.style.cssText = 'position:relative;overflow:hidden;width:100%;height:100%;background:#2b2d31'

    var viewport = document.createElement('div')
    viewport.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;box-shadow:0 2px 16px rgba(0,0,0,.4)'

    var iframe = document.createElement('iframe')
    // allow-same-origin lets the viewer build the DOM; without allow-scripts nothing recorded can execute.
    iframe.setAttribute('sandbox', 'allow-same-origin')
    iframe.setAttribute('title', 'Session replay')
    iframe.style.cssText = 'border:0;display:block;background:#fff;pointer-events:none'

    var cursor = document.createElement('div')
    cursor.innerHTML = CURSOR_SVG
    cursor.style.cssText = 'position:absolute;left:0;top:0;width:20px;height:20px;pointer-events:none;' +
      'transition:transform .05s linear;display:none;z-index:2'

    var effects = document.createElement('div')
    effects.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1'

    viewport.appendChild(iframe)
    viewport.appendChild(effects)
    viewport.appendChild(cursor)
    wrapper.appendChild(viewport)
    c.appendChild(wrapper)

    this.wrapper = wrapper
    this.viewport = viewport
    this.iframe = iframe
    this.cursor = cursor
    this.effects = effects

    var self = this
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(function () { self._fit() })
      this._resizeObserver.observe(wrapper)
    }
    this._setViewport(this.vw, this.vh)
  }

  LogItReplayer.prototype._setViewport = function (w, h) {
    if (!w || !h) return
    this.vw = w
    this.vh = h
    this.iframe.style.width = w + 'px'
    this.iframe.style.height = h + 'px'
    this.viewport.style.width = w + 'px'
    this.viewport.style.height = h + 'px'
    this._fit()
  }

  LogItReplayer.prototype._fit = function () {
    var W = this.wrapper.clientWidth || this.vw
    var H = this.wrapper.clientHeight || this.vh
    var s = Math.min(W / this.vw, H / this.vh, 1)
    var x = Math.max(0, (W - this.vw * s) / 2)
    var y = Math.max(0, (H - this.vh * s) / 2)
    this.viewport.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')'
  }

  LogItReplayer.prototype.getDocument = function () {
    return this.iframe.contentDocument
  }

  // ---------------------------------------------------------------- URLs (archived assets)

  LogItReplayer.prototype._url = function (url) {
    var resolve = this.options.resolveUrl
    return resolve && url ? resolve(url) || url : url
  }

  LogItReplayer.prototype._css = function (css) {
    if (!this.options.resolveUrl || !css || css.indexOf('url(') === -1) return css
    var self = this
    return css.replace(CSS_URL_RE, function (m, quote, u) { return 'url(' + quote + self._url(u) + quote + ')' })
  }

  LogItReplayer.prototype._srcset = function (value) {
    if (!this.options.resolveUrl) return value
    var self = this
    return String(value).split(',').map(function (part) {
      var bits = part.trim().split(/\s+/)
      if (bits[0]) bits[0] = self._url(bits[0])
      return bits.join(' ')
    }).join(', ')
  }

  // ---------------------------------------------------------------- DOM rebuilding

  // Clears a document and leaves it in standards mode.
  function resetDocument(doc) {
    doc.open()
    doc.write('<!DOCTYPE html><html><head></head><body></body></html>')
    doc.close()
    while (doc.firstChild) doc.removeChild(doc.firstChild)
    return doc
  }

  LogItReplayer.prototype._fillDocument = function (doc, sn) {
    resetDocument(doc)
    this.nodes.set(sn.id, doc)
    var children = sn.childNodes || []
    for (var i = 0; i < children.length; i++) {
      var n = this._build(children[i], doc, null)
      if (n) { try { doc.appendChild(n) } catch (e) { /* e.g. second doctype */ } }
    }
    this._applyAdopted(doc, sn.adopted)
    this._flushFrames()
  }

  LogItReplayer.prototype._rebuild = function (snap) {
    this._pauseMedia()
    this._resetState()
    if (!snap.node) return
    this._fillDocument(this.iframe.contentDocument, snap.node)
    this._setViewport(snap.width, snap.height)
    if (snap.scroll) this._scrollDoc(this.iframe.contentDocument, snap.scroll.x, snap.scroll.y)
  }

  LogItReplayer.prototype._build = function (sn, doc, parentTag) {
    var node
    switch (sn.type) {
      case 10:
        try { node = doc.implementation.createDocumentType(sn.name || 'html', sn.publicId || '', sn.systemId || '') } catch (e) { return null }
        break
      case 3: node = doc.createTextNode(parentTag === 'style' ? this._css(sn.text || '') : (sn.text || '')); break
      case 8: node = doc.createComment(sn.text || ''); break
      case 1: node = this._buildElement(sn, doc); break
      default: return null
    }
    this.nodes.set(sn.id, node)
    return node
  }

  LogItReplayer.prototype._buildElement = function (sn, doc) {
    var tag = sn.tag
    // Inlined <link rel=stylesheet> CSS is replayed as a <style> so it no longer depends on the live URL.
    var asStyle = tag === 'link' && sn.cssText != null
    var el
    try {
      if (asStyle) el = doc.createElement('style')
      else el = sn.svg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag)
    } catch (e) {
      el = doc.createElement('div')
    }
    var attrs = sn.attrs || {}
    if (asStyle) {
      if (attrs.media) el.setAttribute('media', attrs.media)
    } else {
      for (var name in attrs) this._setAttr(el, tag, name, attrs[name])
    }
    if (tag === 'script') el.setAttribute('type', 'text/logit-disabled')
    if (sn.blocked) {
      el.style.background = 'repeating-linear-gradient(45deg,#ddd,#ddd 10px,#eee 10px,#eee 20px)'
      el.setAttribute('title', 'Blocked by LogIt privacy settings')
      el.setAttribute('data-logit-blocked', '')
    }
    var children = sn.childNodes || []
    for (var i = 0; i < children.length; i++) {
      var c = this._build(children[i], doc, tag)
      if (c) { try { el.appendChild(c) } catch (e) { /* invalid nesting */ } }
    }
    if (sn.shadow) this._attachShadow(el, sn.shadow)
    if (sn.cssText != null) el.textContent = this._css(sn.cssText)
    if (sn.value != null) { try { el.value = sn.value } catch (e) { /* ignore */ } }
    if (sn.doc) this._pendingFrames.push({ el: el, doc: sn.doc })
    if (sn.canvas) this._drawFrame(el, sn.canvas)
    if (sn.media) this._setMedia(el, sn.media, null)
    return el
  }

  LogItReplayer.prototype._attachShadow = function (host, sn) {
    var shadow
    try {
      // Closed roots are replayed as open ones so the replayer can reach into them.
      shadow = host.shadowRoot || host.attachShadow({ mode: 'open' })
    } catch (e) {
      return
    }
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild)
    this.nodes.set(sn.id, shadow)
    var doc = host.ownerDocument
    var children = sn.childNodes || []
    for (var i = 0; i < children.length; i++) {
      var c = this._build(children[i], doc, null)
      if (c) { try { shadow.appendChild(c) } catch (e) { /* ignore */ } }
    }
    this._applyAdopted(shadow, sn.adopted)
  }

  // An iframe's document only exists once the iframe element is attached to a document.
  LogItReplayer.prototype._flushFrames = function () {
    var pending = this._pendingFrames
    this._pendingFrames = []
    for (var i = 0; i < pending.length; i++) {
      var p = pending[i]
      if (!p.el.isConnected) continue
      try {
        var doc = p.el.contentDocument
        if (doc) this._fillDocument(doc, p.doc)
      } catch (e) { /* ignore */ }
    }
  }

  LogItReplayer.prototype._setAttr = function (el, tag, name, value) {
    if (/^on/i.test(name)) return
    if (tag === 'script' && (name === 'src' || name === 'type')) return
    if (EMBED_TAGS[tag] && (name === 'src' || name === 'srcdoc' || name === 'data')) return
    if (tag === 'meta' && name === 'http-equiv') return
    if (tag === 'base' && name === 'href') return
    if (el.tagName === 'STYLE' && tag === 'link') return // inlined stylesheet: only CSS updates matter
    if (value !== null) {
      if (URL_ATTRS[name]) value = this._url(value)
      else if (name === 'srcset') value = this._srcset(value)
      else if (name === 'style') value = this._css(value)
    }
    try {
      if (value === null) el.removeAttribute(name)
      else el.setAttribute(name, value)
    } catch (e) { /* invalid attribute name */ }
  }

  // ---------------------------------------------------------------- constructed stylesheets

  LogItReplayer.prototype._sheetFor = function (doc, id) {
    var list = this.sheetInstances.get(id) || []
    for (var i = 0; i < list.length; i++) {
      if (list[i].__logitDoc === doc) return list[i]
    }
    var win = doc.defaultView
    if (!win || !win.CSSStyleSheet) return null
    var sheet = new win.CSSStyleSheet()
    try { sheet.replaceSync(this._css(this.sheetDefs.get(id) || '')) } catch (e) { /* ignore */ }
    sheet.__logitDoc = doc
    list.push(sheet)
    this.sheetInstances.set(id, list)
    return sheet
  }

  LogItReplayer.prototype._applyAdopted = function (rootNode, refs) {
    if (!refs) return
    var doc = rootNode.nodeType === 9 ? rootNode : rootNode.ownerDocument
    var sheets = []
    for (var i = 0; i < refs.length; i++) {
      if (refs[i].css != null) this.sheetDefs.set(refs[i].id, refs[i].css)
      var sheet = this._sheetFor(doc, refs[i].id)
      if (sheet) sheets.push(sheet)
    }
    try { rootNode.adoptedStyleSheets = sheets } catch (e) { /* unsupported */ }
  }

  LogItReplayer.prototype._updateSheet = function (d) {
    var list = this.sheetInstances.get(d.sheetId) || []
    var self = this
    if (d.css != null) {
      this.sheetDefs.set(d.sheetId, d.css)
      list.forEach(function (s) { try { s.replaceSync(self._css(d.css)) } catch (e) { /* ignore */ } })
      return
    }
    list.forEach(function (s) {
      try {
        if (d.remove != null) s.deleteRule(d.remove)
        else s.insertRule(self._css(d.rule), Math.min(d.index || 0, s.cssRules.length))
      } catch (e) { /* ignore */ }
    })
    if (list[0]) {
      var text = ''
      for (var i = 0; i < list[0].cssRules.length; i++) text += list[0].cssRules[i].cssText + '\n'
      this.sheetDefs.set(d.sheetId, text)
    }
  }

  // ---------------------------------------------------------------- mutations

  LogItReplayer.prototype._mutate = function (d) {
    var self = this
    ;(d.removes || []).forEach(function (r) {
      var n = self.nodes.get(r.id)
      if (n && n.parentNode) n.parentNode.removeChild(n)
    })
    ;(d.adds || []).forEach(function (a) {
      var parent = self.nodes.get(a.parentId)
      if (!parent) return
      var doc = parent.nodeType === 9 ? parent : parent.ownerDocument
      var parentTag = parent.nodeType === 1 ? parent.tagName.toLowerCase() : null
      var node = self._build(a.node, doc, parentTag)
      if (!node) return
      var next = a.nextId != null ? self.nodes.get(a.nextId) : null
      try {
        if (next && next.parentNode === parent) parent.insertBefore(node, next)
        else parent.appendChild(node)
      } catch (e) { /* invalid insertion */ }
    })
    ;(d.attrs || []).forEach(function (a) {
      var el = self.nodes.get(a.id)
      if (!el || el.nodeType !== 1) return
      var tag = el.tagName.toLowerCase()
      for (var name in a.attrs) self._setAttr(el, tag, name, a.attrs[name])
    })
    ;(d.texts || []).forEach(function (t) {
      var n = self.nodes.get(t.id)
      if (!n) return
      var inStyle = n.parentNode && n.parentNode.nodeName === 'STYLE'
      n.nodeValue = inStyle ? self._css(t.text) : t.text
    })
    this._flushFrames()
  }

  LogItReplayer.prototype._styleEvent = function (d) {
    if (d.sheetId != null) return this._updateSheet(d)
    var n = this.nodes.get(d.id)
    if (!n) return
    if (d.css != null) {
      // A linked stylesheet finished loading after the snapshot: swap the <link> for its CSS.
      if (n.tagName === 'LINK') {
        var style = n.ownerDocument.createElement('style')
        if (n.getAttribute('media')) style.setAttribute('media', n.getAttribute('media'))
        if (n.parentNode) n.parentNode.replaceChild(style, n)
        this.nodes.set(d.id, style)
        n = style
      }
      n.textContent = this._css(d.css)
      return
    }
    if (!n.sheet) return
    if (d.remove != null) n.sheet.deleteRule(d.remove)
    else n.sheet.insertRule(this._css(d.rule), Math.min(d.index || 0, n.sheet.cssRules.length))
  }

  // ---------------------------------------------------------------- canvas + media

  LogItReplayer.prototype._drawFrame = function (el, data) {
    if (el.tagName === 'VIDEO') {
      el.setAttribute('poster', data)
      return
    }
    if (!el.getContext) return
    el.__logitFrame = data
    var img = new Image()
    img.onload = function () {
      if (el.__logitFrame !== data) return // a newer frame won the race
      try {
        var ctx = el.getContext('2d')
        ctx.clearRect(0, 0, el.width, el.height)
        ctx.drawImage(img, 0, 0, el.width, el.height)
      } catch (e) { /* ignore */ }
    }
    img.src = data
  }

  // Replayed media is always muted: autoplay with sound is blocked without a gesture inside the frame.
  LogItReplayer.prototype._setMedia = function (el, state, offset) {
    this.media.set(el, { state: state, offset: offset })
    try {
      el.muted = true
      el.loop = !!state.loop
      el.playbackRate = (state.rate || 1) * this.speed
      if (isFinite(state.time)) el.currentTime = state.time
      if (state.paused || !this.playing) el.pause()
      else el.play().catch(function () {})
    } catch (e) { /* media not ready */ }
  }

  // After a seek, playing media must jump to where it would be by now.
  LogItReplayer.prototype._syncMedia = function () {
    var self = this
    this.media.forEach(function (m, el) {
      if (!el.isConnected) { self.media.delete(el); return }
      try {
        var t = m.state.time
        if (!m.state.paused && m.offset != null) t += ((self.current - m.offset) / 1000) * (m.state.rate || 1)
        if (isFinite(t)) el.currentTime = t
        el.playbackRate = (m.state.rate || 1) * self.speed
        if (!m.state.paused && self.playing) el.play().catch(function () {})
        else el.pause()
      } catch (e) { /* ignore */ }
    })
  }

  LogItReplayer.prototype._pauseMedia = function () {
    if (!this.media) return
    this.media.forEach(function (m, el) {
      try { el.pause() } catch (e) { /* ignore */ }
    })
  }

  // ---------------------------------------------------------------- applying events

  LogItReplayer.prototype._scrollDoc = function (doc, x, y) {
    try { (doc.defaultView || this.iframe.contentWindow).scrollTo(x || 0, y || 0) } catch (e) { /* ignore */ }
  }

  LogItReplayer.prototype._moveCursor = function (x, y) {
    this.cursor.style.display = 'block'
    this.cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'
  }

  LogItReplayer.prototype._ripple = function (x, y) {
    var dot = document.createElement('div')
    dot.style.cssText = 'position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;' +
      'background:rgba(233,69,96,.45);border:2px solid #e94560;left:' + x + 'px;top:' + y + 'px;' +
      'transition:transform .5s ease-out,opacity .5s ease-out'
    this.effects.appendChild(dot)
    requestAnimationFrame(function () {
      dot.style.transform = 'scale(2)'
      dot.style.opacity = '0'
    })
    setTimeout(function () { dot.remove() }, 600)
  }

  // sync = true while seeking: skip visual effects that only make sense in real time.
  LogItReplayer.prototype._apply = function (ev, sync) {
    var d = ev.data || {}
    var n
    switch (ev.type) {
      case 'snapshot':
        this._rebuild(d)
        break
      case 'mutation':
        this._mutate(d)
        break
      case 'shadow':
        n = this.nodes.get(d.hostId)
        if (n) this._attachShadow(n, d.node)
        break
      case 'iframe':
        n = this.nodes.get(d.id)
        if (n) {
          this._pendingFrames.push({ el: n, doc: d.node })
          this._flushFrames()
        }
        break
      case 'adopted':
        n = this.nodes.get(d.id)
        if (n) this._applyAdopted(n, d.sheets)
        break
      case 'style':
        this._styleEvent(d)
        break
      case 'input':
        n = this.nodes.get(d.id)
        if (n) {
          if ('checked' in d) n.checked = d.checked
          if ('value' in d) n.value = d.value
        }
        break
      case 'scroll':
        n = this.nodes.get(d.id)
        if (n && n.nodeType === 9) this._scrollDoc(n, d.x, d.y)
        else if (n) { n.scrollLeft = d.x; n.scrollTop = d.y }
        break
      case 'viewport':
        this._setViewport(d.width, d.height)
        break
      case 'mouse':
        this._moveCursor(d.x, d.y)
        break
      case 'click':
        if (d.x == null) break
        this._moveCursor(d.x, d.y)
        if (!sync) this._ripple(d.x, d.y)
        break
      case 'canvas':
        if (this._pendingCanvas) this._pendingCanvas.set(d.id, d.data)
        else if ((n = this.nodes.get(d.id))) this._drawFrame(n, d.data)
        break
      case 'media':
        n = this.nodes.get(d.id)
        if (n) this._setMedia(n, d, ev.t - this.startTime)
        break
    }
  }

  LogItReplayer.prototype._safeApply = function (ev, sync) {
    try { this._apply(ev, sync) } catch (e) { /* a bad event must not stop playback */ }
  }

  // ---------------------------------------------------------------- playback

  LogItReplayer.prototype.play = function () {
    if (this.playing || !this.events.length) return
    if (this.current >= this.duration) this.seek(0)
    this.playing = true
    this._lastFrame = performance.now()
    this._raf = requestAnimationFrame(this._tick)
    this._syncMedia()
    this._emit('play')
  }

  LogItReplayer.prototype.pause = function () {
    if (!this.playing) return
    this.playing = false
    cancelAnimationFrame(this._raf)
    this._pauseMedia()
    this._emit('pause')
  }

  LogItReplayer.prototype.toggle = function () {
    if (this.playing) this.pause()
    else this.play()
  }

  LogItReplayer.prototype.setSpeed = function (speed) {
    this.speed = speed
    this._syncMedia()
  }

  LogItReplayer.prototype.setSkipInactive = function (on) {
    this.options.skipInactive = !!on
  }

  LogItReplayer.prototype._tick = function (ts) {
    if (!this.playing) return
    var target = this.current + (ts - this._lastFrame) * this.speed
    this._lastFrame = ts
    var next = this.events[this.index]
    if (this.options.skipInactive && next) {
      var nextOffset = next.t - this.startTime
      if (nextOffset - target > this.options.inactiveThreshold) {
        target = nextOffset - 300
        this._advanceTo(target)
        this._syncMedia()
        this._emit('skip', target)
      }
    }
    this._advanceTo(Math.min(target, this.duration))
    this._emit('time', this.current)
    if (this.current >= this.duration) {
      this.pause()
      this._emit('end')
    } else {
      this._raf = requestAnimationFrame(this._tick)
    }
  }

  LogItReplayer.prototype._advanceTo = function (offset) {
    while (this.index < this.events.length && this.events[this.index].t - this.startTime <= offset) {
      this._safeApply(this.events[this.index++], false)
    }
    this.current = offset
  }

  LogItReplayer.prototype.seek = function (offset) {
    offset = Math.max(0, Math.min(offset, this.duration))
    var snap = -1
    var first = -1
    for (var i = 0; i < this.events.length; i++) {
      var ev = this.events[i]
      if (ev.type === 'snapshot') {
        if (first < 0) first = i
        if (ev.t - this.startTime <= offset) snap = i
      }
      if (ev.t - this.startTime > offset && first >= 0) break
    }
    if (snap < 0) snap = first
    if (snap < 0) {
      this._pauseMedia()
      this._resetState()
      resetDocument(this.iframe.contentDocument)
      this.index = 0
    } else {
      // Only the last frame of each canvas matters while fast-forwarding.
      this._pendingCanvas = new Map()
      this._safeApply(this.events[snap], true)
      this.index = snap + 1
      while (this.index < this.events.length && this.events[this.index].t - this.startTime <= offset) {
        this._safeApply(this.events[this.index++], true)
      }
      var frames = this._pendingCanvas
      this._pendingCanvas = null
      var self = this
      frames.forEach(function (data, id) {
        var n = self.nodes.get(id)
        if (n) self._drawFrame(n, data)
      })
    }
    this.current = offset
    this._syncMedia()
    this._emit('time', offset)
  }

  LogItReplayer.prototype.getCurrentTime = function () {
    return this.current
  }

  LogItReplayer.prototype.destroy = function () {
    this.pause()
    this._pauseMedia()
    if (this._resizeObserver) this._resizeObserver.disconnect()
    this.listeners = {}
    this.container.textContent = ''
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = LogItReplayer
  else root.LogItReplayer = LogItReplayer
})(typeof window !== 'undefined' ? window : this)
