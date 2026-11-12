'use strict'

// Minimal headless Chrome driver over the DevTools Protocol (no dependencies).

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

function findChrome() {
  return CANDIDATES.find(p => p && fs.existsSync(p)) || null
}

async function launch(chromePath) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logit-chrome-'))
  const proc = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1200,900', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 20000)
    proc.stderr.on('data', d => {
      buf += d
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) { clearTimeout(timer); resolve(m[1]) }
    })
    proc.on('exit', code => reject(new Error('Chrome exited with ' + code)))
  })

  const port = new URL(wsUrl).port
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = targets.find(t => t.type === 'page')
  const cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  return {
    cdp,
    async goto(url, timeout = 15000) {
      const loaded = cdp.once('Page.loadEventFired')
      await cdp.send('Page.navigate', { url })
      let timer
      await Promise.race([
        loaded,
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Timed out loading ' + url)), timeout) })
      ]).finally(() => clearTimeout(timer))
    },
    async evaluate(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails))
      return r.result.value
    },
    async waitFor(expression, timeout = 10000) {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (await this.evaluate(expression).catch(() => false)) return
        await new Promise(r => setTimeout(r, 100))
      }
      throw new Error('Timed out waiting for: ' + expression)
    },
    async type(text) {
      await cdp.send('Input.insertText', { text })
    },
    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      }
    },
    async close() {
      cdp.close()
      proc.kill()
      await new Promise(r => proc.once('exit', r))
      fs.rmSync(userDir, { recursive: true, force: true })
    }
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let nextId = 1
    const pending = new Map()
    const waiters = []
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = nextId++
        ws.send(JSON.stringify({ id, method, params }))
        return new Promise((res, rej) => pending.set(id, { res, rej }))
      },
      once(method) {
        return new Promise(res => waiters.push({ method, res }))
      },
      close() { ws.close() }
    })
    ws.onerror = reject
    ws.onmessage = msg => {
      const data = JSON.parse(msg.data)
      if (data.id && pending.has(data.id)) {
        const p = pending.get(data.id)
        pending.delete(data.id)
        if (data.error) p.rej(new Error(data.error.message))
        else p.res(data.result)
      } else if (data.method) {
        const i = waiters.findIndex(w => w.method === data.method)
        if (i >= 0) waiters.splice(i, 1)[0].res(data.params)
      }
    }
  })
}

module.exports = { findChrome, launch }
