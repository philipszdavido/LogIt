/*!
 * LogIt replayer
 * Rebuilds a recorded session inside a sandboxed iframe (scripts never run) and plays it back.
 *
 *   const player = new LogItReplayer(containerEl, events, { speed: 1, skipInactive: true })
 *   player.on('time', ms => ...); player.play(); player.seek(ms); player.setSpeed(2)
 */
(function (root) {
  'use strict'

  var SVG_NS = 'http://www.w3.org/2000/svg'
  var EMBED_TAGS = { iframe: 1, frame: 1, object: 1, embed: 1 }
  var CURSOR_SVG = '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M2 1l14 8.5-6.2 1.3L13 18l-2.6 1.1-3.2-7.1L2 16z" fill="#111" stroke="#fff" stroke-width="1.2"/></svg>'

  function LogItReplayer(container, events, options) {
    this.container = container
    this.options = Object.assign({ speed: 1, skipInactive: true, inactiveThreshold: 4000 }, options)
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
    this.nodes = new Map()
    this.listeners = {}
    this.vw = 1280
    this.vh = 720
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

  // ---------------------------------------------------------------- DOM rebuilding

  LogItReplayer.prototype._resetDocument = function () {
    var doc = this.iframe.contentDocument
    doc.open()
    doc.write('<!DOCTYPE html><html><head></head><body></body></html>') // forces standards mode
    doc.close()
    while (doc.firstChild) doc.removeChild(doc.firstChild)
    this.nodes = new Map()
    return doc
  }

  LogItReplayer.prototype._rebuild = function (snap) {
    var doc = this._resetDocument()
    var rootNode = snap.node
    if (!rootNode) return
    this.nodes.set(rootNode.id, doc)
    var children = rootNode.childNodes || []
    for (var i = 0; i < children.length; i++) {
      var n = this._build(children[i], doc)
      if (n) { try { doc.appendChild(n) } catch (e) { /* e.g. second doctype */ } }
    }
    this._setViewport(snap.width, snap.height)
    if (snap.scroll) this._scrollWindow(snap.scroll.x, snap.scroll.y)
  }

  LogItReplayer.prototype._build = function (sn, doc) {
    var node
    switch (sn.type) {
      case 10:
        try { node = doc.implementation.createDocumentType(sn.name || 'html', sn.publicId || '', sn.systemId || '') } catch (e) { return null }
        break
      case 3: node = doc.createTextNode(sn.text || ''); break
      case 8: node = doc.createComment(sn.text || ''); break
      case 1: node = this._buildElement(sn, doc); break
      default: return null
    }
    this.nodes.set(sn.id, node)
    return node
  }

  LogItReplayer.prototype._buildElement = function (sn, doc) {
    var tag = sn.tag
    var el
    try { el = sn.svg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag) } catch (e) { el = doc.createElement('div') }
    var attrs = sn.attrs || {}
    for (var name in attrs) this._setAttr(el, tag, name, attrs[name])
    if (tag === 'script') el.setAttribute('type', 'text/logit-disabled')
    if (sn.blocked) {
      el.style.background = 'repeating-linear-gradient(45deg,#ddd,#ddd 10px,#eee 10px,#eee 20px)'
      el.setAttribute('title', 'Blocked by LogIt privacy settings')
      el.setAttribute('data-logit-blocked', '')
    }
    var children = sn.childNodes || []
    for (var i = 0; i < children.length; i++) {
      var c = this._build(children[i], doc)
      if (c) { try { el.appendChild(c) } catch (e) { /* invalid nesting */ } }
    }
    if (sn.cssText != null) el.textContent = sn.cssText
    if (sn.value != null) { try { el.value = sn.value } catch (e) { /* ignore */ } }
    return el
  }

  LogItReplayer.prototype._setAttr = function (el, tag, name, value) {
    if (/^on/i.test(name)) return
    if (tag === 'script' && (name === 'src' || name === 'type')) return
    if (EMBED_TAGS[tag] && (name === 'src' || name === 'srcdoc' || name === 'data')) return
    if (tag === 'meta' && name === 'http-equiv') return
    if (tag === 'base' && name === 'href') return
    try {
      if (value === null) el.removeAttribute(name)
      else el.setAttribute(name, value)
    } catch (e) { /* invalid attribute name */ }
  }

  LogItReplayer.prototype._mutate = function (d) {
    var self = this
    var doc = this.iframe.contentDocument
    ;(d.removes || []).forEach(function (r) {
      var n = self.nodes.get(r.id)
      if (n && n.parentNode) n.parentNode.removeChild(n)
    })
    ;(d.adds || []).forEach(function (a) {
      var parent = self.nodes.get(a.parentId)
      if (!parent) return
      var node = self._build(a.node, doc)
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
      if (n) n.nodeValue = t.text
    })
  }

  LogItReplayer.prototype._scrollWindow = function (x, y) {
    try { this.iframe.contentWindow.scrollTo(x || 0, y || 0) } catch (e) { /* ignore */ }
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
      case 'input':
        n = this.nodes.get(d.id)
        if (n) {
          if ('checked' in d) n.checked = d.checked
          if ('value' in d) n.value = d.value
        }
        break
      case 'scroll':
        n = this.nodes.get(d.id)
        if (n && n.nodeType === 9) this._scrollWindow(d.x, d.y)
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
      case 'style':
        n = this.nodes.get(d.id)
        if (n && n.sheet) {
          if (d.remove != null) n.sheet.deleteRule(d.remove)
          else n.sheet.insertRule(d.rule, Math.min(d.index || 0, n.sheet.cssRules.length))
        }
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
    this._emit('play')
  }

  LogItReplayer.prototype.pause = function () {
    if (!this.playing) return
    this.playing = false
    cancelAnimationFrame(this._raf)
    this._emit('pause')
  }

  LogItReplayer.prototype.toggle = function () {
    if (this.playing) this.pause()
    else this.play()
  }

  LogItReplayer.prototype.setSpeed = function (speed) {
    this.speed = speed
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
      this._resetDocument()
      this.index = 0
    } else {
      this._safeApply(this.events[snap], true)
      this.index = snap + 1
      while (this.index < this.events.length && this.events[this.index].t - this.startTime <= offset) {
        this._safeApply(this.events[this.index++], true)
      }
    }
    this.current = offset
    this._emit('time', offset)
  }

  LogItReplayer.prototype.getCurrentTime = function () {
    return this.current
  }

  LogItReplayer.prototype.destroy = function () {
    this.pause()
    if (this._resizeObserver) this._resizeObserver.disconnect()
    this.listeners = {}
    this.container.textContent = ''
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = LogItReplayer
  else root.LogItReplayer = LogItReplayer
})(typeof window !== 'undefined' ? window : this)
