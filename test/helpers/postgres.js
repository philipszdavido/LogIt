'use strict'

// Provides a Postgres URL for tests: LOGIT_TEST_DATABASE_URL if set, otherwise a throwaway local
// cluster (initdb + pg_ctl). Resolves to null when neither is available, so callers can skip.

const { execFileSync, spawnSync } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function startPostgres() {
  if (process.env.LOGIT_TEST_DATABASE_URL) return { url: process.env.LOGIT_TEST_DATABASE_URL, stop: async () => {} }
  try {
    require.resolve('pg')
  } catch (e) {
    return null
  }
  const initdb = which('initdb')
  const pgCtl = which('pg_ctl')
  if (!initdb || !pgCtl) return null

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logit-pg-'))
  const port = await freePort()
  execFileSync(initdb, ['-D', dir, '-U', 'postgres', '--auth=trust', '--no-sync'], { stdio: 'ignore' })
  execFileSync(pgCtl, ['-D', dir, '-l', path.join(dir, 'log'), '-w', '-o',
    `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, 'start'], { stdio: 'ignore' })
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      try { execFileSync(pgCtl, ['-D', dir, '-m', 'immediate', 'stop'], { stdio: 'ignore' }) } catch (e) { /* already stopped */ }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

module.exports = { startPostgres }
