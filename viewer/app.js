/* LogIt viewer. All recorded data is untrusted: it is only ever rendered via textContent. */
(function () {
  'use strict'

  const $ = id => document.getElementById(id)
  const TOKEN_KEY = 'logit_token'
  const APP_KEY = 'logit_app'
  const PAGE_SIZE = 50

  const state = {
    appId: '',
    sessions: [],
    total: 0,
    current: null,
    replayer: null,
    tab: 'console',
    rows: [],
    lastTimeUpdate: -1
  }
  window.logitViewer = state

  // ---------------------------------------------------------------- helpers

  function storageGet(k) { try { return localStorage.getItem(k) || '' } catch (e) { return '' } }
  function storageSet(k, v) { try { localStorage.setItem(k, v) } catch (e) { /* ignore */ } }

  function el(tag, props, ...children) {
    const n = document.createElement(tag)
    if (props) {
      for (const k in props) {
        if (props[k] == null || props[k] === false) continue
        if (k === 'class') n.className = props[k]
        else if (k === 'text') n.textContent = props[k]
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), props[k])
        else n.setAttribute(k, props[k])
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
    }
    return n
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = String(s % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
  }

  function fmtAgo(t) {
    const s = Math.round((Date.now() - t) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return Math.floor(s / 60) + 'm ago'
    if (s < 86400) return Math.floor(s / 3600) + 'h ago'
    return new Date(t).toLocaleDateString()
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }

  function shortUrl(url) {
    try {
      const u = new URL(url)
      return u.host + u.pathname + u.search
    } catch (e) {
      return url || ''
    }
  }

  function preview(v) {
    if (typeof v === 'string') return v
    let s
    try { s = JSON.stringify(v) } catch (e) { s = String(v) }
    return s && s.length > 300 ? s.slice(0, 300) + '…' : s
  }

  function pretty(v) {
    if (typeof v === 'string') return v
    try { return JSON.stringify(v, null, 2) } catch (e) { return String(v) }
  }

  function details(label, content) {
    if (content == null || content === '' || (typeof content === 'object' && !Object.keys(content).length)) return null
    return el('details', null, el('summary', { text: label }), el('pre', { text: pretty(content) }))
  }

  // ---------------------------------------------------------------- API

  function askToken() {
    return new Promise(resolve => {
      const dialog = $('token-dialog')
      $('token-input').value = storageGet(TOKEN_KEY)
      dialog.returnValue = ''
      dialog.addEventListener('close', () => {
        if (dialog.returnValue === 'save') {
          storageSet(TOKEN_KEY, $('token-input').value.trim())
          resolve(true)
        } else {
          resolve(false)
        }
      }, { once: true })
      dialog.showModal()
    })
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers)
    const token = storageGet(TOKEN_KEY)
    if (token) headers.Authorization = 'Bearer ' + token
    const res = await fetch(path, Object.assign({}, opts, { headers }))
    if (res.status === 401) {
      if (await askToken()) return api(path, opts)
      throw new Error('An API token is required')
    }
    if (!res.ok) {
      let msg
      try { msg = (await res.json()).error } catch (e) { /* ignore */ }
      throw new Error(msg || 'HTTP ' + res.status)
    }
    return res.status === 204 ? null : res.json()
  }

  // ---------------------------------------------------------------- session list

  async function loadApps() {
    const { apps } = await api('/api/apps')
    const select = $('app-select')
    select.textContent = ''
    select.appendChild(el('option', { value: '', text: 'All apps' }))
    for (const a of apps) select.appendChild(el('option', { value: a.appId, text: `${a.appId} (${a.sessions})` }))
    const saved = storageGet(APP_KEY)
    if (apps.some(a => a.appId === saved)) select.value = saved
    state.appId = select.value
  }

  async function loadSessions(append) {
    const params = new URLSearchParams({ limit: PAGE_SIZE, offset: append ? state.sessions.length : 0 })
    if (state.appId) params.set('appId', state.appId)
    if ($('search').value.trim()) params.set('q', $('search').value.trim())
    if ($('errors-only').checked) params.set('errors', '1')
    const data = await api('/api/sessions?' + params)
    state.sessions = append ? state.sessions.concat(data.sessions) : data.sessions
    state.total = data.total
    renderSessions()
  }

  function renderSessions() {
    const list = $('session-list')
    list.textContent = ''
    $('session-count').textContent = state.total === 1 ? '1 session' : `${state.total} sessions`
    for (const s of state.sessions) {
      const active = state.current && state.current.appId === s.appId && state.current.sessionId === s.sessionId
      const badges = el('div', { class: 'badges' },
        el('span', { class: 'badge', text: fmtClock(s.lastEventAt - s.startedAt) }),
        s.pageCount > 1 && el('span', { class: 'badge', text: `${s.pageCount} pages` }),
        s.errorCount > 0 && el('span', { class: 'badge err', text: `${s.errorCount} error${s.errorCount > 1 ? 's' : ''}` }),
        s.failedRequests > 0 && el('span', { class: 'badge err', text: `${s.failedRequests} failed req` }),
        s.slowRequests > 0 && el('span', { class: 'badge warn', text: `${s.slowRequests} slow req` }),
        !state.appId && el('span', { class: 'badge', text: s.appId })
      )
      list.appendChild(el('li', {
        class: active ? 'active' : '',
        onclick: () => { location.hash = `#/session/${encodeURIComponent(s.appId)}/${encodeURIComponent(s.sessionId)}` }
      },
      el('div', { class: 's-top' },
        el('span', { class: 's-user', text: (s.user && s.user.id) || 'Anonymous' }),
        el('span', { class: 'muted', text: fmtAgo(s.lastEventAt) })
      ),
      el('div', { class: 's-url', text: shortUrl(s.lastUrl || s.firstUrl) }),
      badges))
    }
    $('load-more').hidden = state.sessions.length >= state.total
  }

  // ---------------------------------------------------------------- player

  function route() {
    const m = location.hash.match(/^#\/session\/([^/]+)\/([^/]+)$/)
    if (m) openSession(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
    else closeSession()
  }

  function closeSession() {
    if (state.replayer) state.replayer.destroy()
    state.replayer = null
    state.current = null
    $('player').hidden = true
    $('devtools').hidden = true
    $('empty').hidden = false
    $('empty').textContent = 'Select a session to replay it.'
    renderSessions()
  }

  async function openSession(appId, sessionId) {
    if (state.current && state.current.appId === appId && state.current.sessionId === sessionId) return
    if (state.replayer) state.replayer.destroy()
    state.replayer = null
    state.current = { appId, sessionId, loading: true }
    renderSessions()
    $('empty').hidden = false
    $('empty').textContent = 'Loading session…'
    $('player').hidden = true
    $('devtools').hidden = true

    let data
    try {
      data = await api(`/api/sessions/${encodeURIComponent(appId)}/${encodeURIComponent(sessionId)}`)
    } catch (e) {
      $('empty').textContent = 'Could not load session: ' + e.message
      return
    }
    if (!state.current || state.current.sessionId !== sessionId) return // user moved on

    state.current = { appId, sessionId, meta: data.meta, events: data.events }
    $('empty').hidden = true
    $('player').hidden = false
    $('devtools').hidden = false

    const meta = data.meta
    $('session-title').textContent = shortUrl(meta.firstUrl) || sessionId
    $('session-sub').textContent = [
      (meta.user && meta.user.id) || 'Anonymous',
      new Date(meta.startedAt).toLocaleString(),
      fmtClock(meta.lastEventAt - meta.startedAt),
      `${meta.eventCount} events`
    ].join(' · ')

    // Archived copies of the page's images, fonts and stylesheets, keyed by original URL.
    const assets = data.assets || {}
    const replayer = new LogItReplayer($('stage'), data.events, {
      speed: Number($('speed').value),
      skipInactive: $('skip').checked,
      resolveUrl: url => (Object.prototype.hasOwnProperty.call(assets, url) ? '/assets/' + assets[url] : null)
    })
    state.replayer = replayer
    replayer.on('time', onTime)
    replayer.on('play', () => { $('play').textContent = '❚❚'; $('play').setAttribute('aria-label', 'Pause') })
    replayer.on('pause', () => { $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play') })

    renderMarkers()
    renderTabs()
    onTime(0)
  }

  function onTime(ms) {
    const r = state.replayer
    if (!r) return
    $('time').textContent = `${fmtClock(ms)} / ${fmtClock(r.duration)}`
    $('progress').style.width = (r.duration ? (ms / r.duration) * 100 : 0) + '%'
    if (Math.abs(ms - state.lastTimeUpdate) < 250) return
    state.lastTimeUpdate = ms
    for (const row of state.rows) row.el.classList.toggle('future', row.offset > ms)
  }

  function offsetOf(ev) {
    return ev.t - state.replayer.startTime
  }

  function renderMarkers() {
    const markers = $('markers')
    markers.textContent = ''
    const r = state.replayer
    if (!r.duration) return
    for (const ev of r.events) {
      let kind = null
      if (ev.type === 'error' || (ev.type === 'console' && ev.data.level === 'error')) kind = 'error'
      else if (ev.type === 'meta' || ev.type === 'nav') kind = 'nav'
      if (kind) markers.appendChild(el('div', { class: 'marker ' + kind, style: `left:${(offsetOf(ev) / r.duration) * 100}%` }))
    }
  }

  function seekFromPointer(e) {
    const r = state.replayer
    if (!r) return
    const rect = $('timeline').getBoundingClientRect()
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
    r.seek(ratio * r.duration)
  }

  // ---------------------------------------------------------------- devtools panel

  const TABS = [
    { id: 'console', label: 'Console', match: ev => ev.type === 'console' || (ev.type === 'custom' && ev.data.kind === 'log') },
    { id: 'network', label: 'Network', match: ev => ev.type === 'network' },
    { id: 'errors', label: 'Errors', match: ev => ev.type === 'error' || (ev.type === 'console' && ev.data.level === 'error') },
    { id: 'activity', label: 'Activity', match: ev => ['click', 'nav', 'meta', 'identify'].includes(ev.type) || (ev.type === 'custom' && ev.data.kind === 'track') },
    { id: 'info', label: 'Info' }
  ]

  function renderTabs() {
    const nav = $('tabs')
    nav.textContent = ''
    const events = state.replayer.events
    for (const tab of TABS) {
      const count = tab.match ? events.filter(tab.match).length : null
      nav.appendChild(el('button', {
        type: 'button',
        class: tab.id === state.tab ? 'active' : '',
        onclick: () => { state.tab = tab.id; renderTabs() }
      }, tab.label, count != null && el('span', { class: 'count muted', text: String(count) })))
    }
    renderPanel()
  }

  function renderPanel() {
    const panel = $('panel')
    panel.textContent = ''
    state.rows = []
    state.lastTimeUpdate = -1
    const tab = TABS.find(t => t.id === state.tab)
    if (!tab.match) {
      panel.appendChild(renderInfo())
      return
    }
    const events = state.replayer.events.filter(tab.match)
    if (!events.length) {
      panel.appendChild(el('div', { class: 'panel-empty', text: 'Nothing recorded.' }))
      return
    }
    for (const ev of events) {
      const content = renderRow(ev)
      const offset = offsetOf(ev)
      const row = el('div', { class: 'row ' + (content.cls || '') },
        el('span', { class: 'ts', text: fmtClock(offset) }),
        el('div', { class: 'body' }, ...content.nodes))
      row.addEventListener('click', e => {
        if (e.target.closest('details')) return
        state.replayer.seek(offset)
      })
      panel.appendChild(row)
      state.rows.push({ offset, el: row })
    }
    onTime(state.replayer.getCurrentTime())
  }

  function renderRow(ev) {
    const d = ev.data || {}
    switch (ev.type) {
      case 'console': {
        const args = d.args || []
        const objects = args.filter(a => a && typeof a === 'object')
        return {
          cls: d.level === 'error' ? 'error' : d.level === 'warn' ? 'warn' : '',
          nodes: [
            el('div', { class: 'line', text: args.map(a => (a && a.__error) ? `${a.__error.name}: ${a.__error.message}` : preview(a)).join(' ') }),
            objects.length ? details('Details', objects.length === 1 ? objects[0] : objects) : null,
            details('Stack', d.stack)
          ]
        }
      }
      case 'custom':
        if (d.kind === 'track') {
          return { nodes: [el('div', { class: 'line', text: `Event: ${d.name}` }), details('Properties', d.data)] }
        }
        return {
          cls: d.level === 'error' ? 'error' : d.level === 'warn' ? 'warn' : '',
          nodes: [el('div', { class: 'line', text: `[LogIt.log] ${d.message}` }), details('Data', d.data)]
        }
      case 'network': {
        const bad = !d.status || d.status >= 400
        return {
          cls: bad ? 'error' : '',
          nodes: [
            el('div', { class: 'net-line' },
              el('span', { class: 'net-status' + (bad ? ' bad' : ''), text: d.status || 'ERR' }),
              el('span', { text: d.method }),
              el('span', { class: 'net-url', title: d.url, text: shortUrl(d.url) }),
              el('span', { class: 'net-dur' + (d.slow ? ' slow' : ''), text: d.duration + 'ms' })),
            d.error ? el('div', { text: d.error }) : null,
            details('Request headers', d.requestHeaders),
            details('Request body', d.requestBody),
            details('Response headers', d.responseHeaders),
            details('Response body', d.responseBody)
          ]
        }
      }
      case 'error':
        return {
          cls: 'error',
          nodes: [
            el('div', { class: 'line', text: d.kind === 'resource' ? `${d.message}: ${d.url}` : `${d.name || 'Error'}: ${d.message}` }),
            d.source ? el('div', { class: 'muted', text: `${d.source}:${d.line}:${d.column}` }) : null,
            details('Stack', d.stack)
          ]
        }
      case 'click':
        return { nodes: [el('div', { text: `Clicked ${d.selector}${d.text ? ` "${d.text}"` : ''}` })] }
      case 'nav':
        return { nodes: [el('div', { text: `Navigated (${d.kind}) to ${shortUrl(d.href)}` })] }
      case 'meta':
        return { nodes: [el('div', { text: `Page loaded: ${shortUrl(d.href)}` })] }
      case 'identify':
        return { nodes: [el('div', { text: `Identified as ${d.id}` }), details('Traits', d.traits)] }
      default:
        return { nodes: [el('div', { text: ev.type })] }
    }
  }

  function table(rows) {
    return el('table', null, ...rows.filter(r => r[1] != null && r[1] !== '').map(([k, v]) =>
      el('tr', null, el('td', { text: k }), el('td', { text: typeof v === 'object' ? JSON.stringify(v) : String(v) }))))
  }

  function renderInfo() {
    const { meta } = state.current
    const events = state.replayer.events
    const pageMeta = events.filter(e => e.type === 'meta').map(e => e.data)
    const first = pageMeta[0] || {}
    const box = el('div', { class: 'info' })

    box.appendChild(el('h4', { text: 'Session' }))
    box.appendChild(table([
      ['Session ID', meta.sessionId],
      ['App', meta.appId],
      ['Started', new Date(meta.startedAt).toLocaleString()],
      ['Duration', fmtClock(meta.lastEventAt - meta.startedAt)],
      ['Events', meta.eventCount],
      ['Stored size', fmtBytes(meta.sizeBytes)]
    ]))

    if (meta.user) {
      box.appendChild(el('h4', { text: 'User' }))
      box.appendChild(table([['ID', meta.user.id], ...Object.entries(meta.user.traits || {})]))
    }

    box.appendChild(el('h4', { text: 'Environment' }))
    box.appendChild(table([
      ['User agent', first.userAgent],
      ['Language', first.language],
      ['Platform', first.platform],
      ['Timezone', first.timezone],
      ['Viewport', first.viewport && `${first.viewport.width} × ${first.viewport.height}`],
      ['Screen', first.screen && `${first.screen.width} × ${first.screen.height} @${first.screen.dpr}x`],
      ['Referrer', first.referrer],
      ['SDK', first.sdkVersion]
    ]))

    box.appendChild(el('h4', { text: 'Pages' }))
    box.appendChild(table(pageMeta.map((p, i) => [`#${i + 1}`, p.href])))

    const perf = events.filter(e => e.type === 'perf').reduce((acc, e) => Object.assign(acc, e.data), {})
    if (Object.keys(perf).length) {
      box.appendChild(el('h4', { text: 'Performance (last page)' }))
      const ms = v => (typeof v === 'number' ? v + ' ms' : v)
      box.appendChild(table([
        ['Time to first byte', ms(perf.ttfb)],
        ['First contentful paint', ms(perf.fcp)],
        ['Largest contentful paint', ms(perf.lcp)],
        ['DOMContentLoaded', ms(perf.domContentLoaded)],
        ['Load', ms(perf.load)],
        ['Transfer size', perf.transferSize != null ? fmtBytes(perf.transferSize) : null]
      ]))
    }
    return box
  }

  // ---------------------------------------------------------------- wiring

  function showError(e) {
    $('session-count').textContent = e.message
  }

  function init() {
    $('app-select').addEventListener('change', e => {
      state.appId = e.target.value
      storageSet(APP_KEY, state.appId)
      loadSessions().catch(showError)
    })
    let searchTimer
    $('search').addEventListener('input', () => {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => loadSessions().catch(showError), 300)
    })
    $('errors-only').addEventListener('change', () => loadSessions().catch(showError))
    $('refresh').addEventListener('click', () => loadApps().then(() => loadSessions()).catch(showError))
    $('load-more').addEventListener('click', () => loadSessions(true).catch(showError))
    $('token-btn').addEventListener('click', () => askToken().then(ok => ok && start()))

    $('play').addEventListener('click', () => state.replayer && state.replayer.toggle())
    $('speed').addEventListener('change', e => state.replayer && state.replayer.setSpeed(Number(e.target.value)))
    $('skip').addEventListener('change', e => state.replayer && state.replayer.setSkipInactive(e.target.checked))

    const timeline = $('timeline')
    let dragging = false
    timeline.addEventListener('pointerdown', e => {
      dragging = true
      timeline.setPointerCapture(e.pointerId)
      seekFromPointer(e)
    })
    timeline.addEventListener('pointermove', e => { if (dragging) seekFromPointer(e) })
    timeline.addEventListener('pointerup', () => { dragging = false })
    timeline.addEventListener('keydown', e => {
      const r = state.replayer
      if (!r) return
      if (e.key === 'ArrowRight') r.seek(r.getCurrentTime() + 5000)
      if (e.key === 'ArrowLeft') r.seek(r.getCurrentTime() - 5000)
    })

    $('copy-link').addEventListener('click', () => {
      navigator.clipboard.writeText(location.href).then(() => {
        $('copy-link').textContent = 'Copied'
        setTimeout(() => { $('copy-link').textContent = 'Copy link' }, 1500)
      })
    })
    $('delete-session').addEventListener('click', async () => {
      const c = state.current
      if (!c || !confirm('Delete this session permanently?')) return
      try {
        await api(`/api/sessions/${encodeURIComponent(c.appId)}/${encodeURIComponent(c.sessionId)}`, { method: 'DELETE' })
        location.hash = '#/'
        await loadSessions()
      } catch (e) {
        alert('Delete failed: ' + e.message)
      }
    })

    document.addEventListener('keydown', e => {
      if (e.code !== 'Space' || !state.replayer) return
      if (e.target.closest('input, select, textarea, button, dialog')) return
      e.preventDefault()
      state.replayer.toggle()
    })

    window.addEventListener('hashchange', route)
    start()
  }

  function start() {
    return loadApps().then(() => loadSessions()).then(route).catch(showError)
  }

  init()
})()
