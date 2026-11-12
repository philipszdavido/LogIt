'use strict'

const zlib = require('zlib')
const { promisify } = require('util')
const { ID_RE, ASSET_ID_RE, newMeta, updateMeta } = require('./meta')

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS logit_sessions (
  app_id          text    NOT NULL,
  session_id      text    NOT NULL,
  started_at      bigint  NOT NULL,
  last_event_at   bigint  NOT NULL,
  received_at     bigint  NOT NULL,
  event_count     integer NOT NULL DEFAULT 0,
  error_count     integer NOT NULL DEFAULT 0,
  failed_requests integer NOT NULL DEFAULT 0,
  slow_requests   integer NOT NULL DEFAULT 0,
  page_count      integer NOT NULL DEFAULT 0,
  first_url       text,
  last_url        text,
  user_agent      text,
  viewport        jsonb,
  user_info       jsonb,
  size_bytes      bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, session_id)
);
CREATE INDEX IF NOT EXISTS logit_sessions_recent ON logit_sessions (last_event_at DESC);
CREATE INDEX IF NOT EXISTS logit_sessions_app_recent ON logit_sessions (app_id, last_event_at DESC);

CREATE TABLE IF NOT EXISTS logit_batches (
  id          bigserial PRIMARY KEY,
  app_id      text    NOT NULL,
  session_id  text    NOT NULL,
  page_id     text    NOT NULL,
  seq         integer,
  received_at bigint  NOT NULL,
  events      bytea   NOT NULL,
  FOREIGN KEY (app_id, session_id) REFERENCES logit_sessions (app_id, session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS logit_batches_session ON logit_batches (app_id, session_id, id);

CREATE TABLE IF NOT EXISTS logit_assets (
  hash         text   PRIMARY KEY,
  content_type text   NOT NULL,
  body         bytea  NOT NULL,
  created_at   bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS logit_session_assets (
  app_id     text NOT NULL,
  session_id text NOT NULL,
  url        text NOT NULL,
  hash       text NOT NULL,
  PRIMARY KEY (app_id, session_id, url),
  FOREIGN KEY (app_id, session_id) REFERENCES logit_sessions (app_id, session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS logit_session_assets_hash ON logit_session_assets (hash);
`

// Each column's merge rule; all right-hand sides see the row as it was before this upsert.
const UPSERT = `
INSERT INTO logit_sessions AS s (
  app_id, session_id, started_at, last_event_at, received_at, event_count, error_count,
  failed_requests, slow_requests, page_count, first_url, last_url, user_agent, viewport, user_info, size_bytes
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
ON CONFLICT (app_id, session_id) DO UPDATE SET
  started_at      = LEAST(s.started_at, EXCLUDED.started_at),
  last_event_at   = GREATEST(s.last_event_at, EXCLUDED.last_event_at),
  received_at     = EXCLUDED.received_at,
  event_count     = s.event_count + EXCLUDED.event_count,
  error_count     = s.error_count + EXCLUDED.error_count,
  failed_requests = s.failed_requests + EXCLUDED.failed_requests,
  slow_requests   = s.slow_requests + EXCLUDED.slow_requests,
  page_count      = s.page_count + EXCLUDED.page_count,
  first_url       = CASE WHEN EXCLUDED.first_url IS NOT NULL AND (s.first_url IS NULL OR EXCLUDED.started_at < s.started_at)
                         THEN EXCLUDED.first_url ELSE s.first_url END,
  last_url        = CASE WHEN EXCLUDED.last_url IS NOT NULL AND EXCLUDED.last_event_at >= s.last_event_at
                         THEN EXCLUDED.last_url ELSE COALESCE(s.last_url, EXCLUDED.last_url) END,
  user_agent      = COALESCE(EXCLUDED.user_agent, s.user_agent),
  viewport        = COALESCE(EXCLUDED.viewport, s.viewport),
  user_info       = COALESCE(EXCLUDED.user_info, s.user_info),
  size_bytes      = s.size_bytes + EXCLUDED.size_bytes
RETURNING *`

function rowToMeta(r) {
  return {
    appId: r.app_id,
    sessionId: r.session_id,
    startedAt: Number(r.started_at),
    lastEventAt: Number(r.last_event_at),
    receivedAt: Number(r.received_at),
    eventCount: r.event_count,
    errorCount: r.error_count,
    failedRequests: r.failed_requests,
    slowRequests: r.slow_requests,
    pageCount: r.page_count,
    firstUrl: r.first_url,
    lastUrl: r.last_url,
    userAgent: r.user_agent,
    viewport: r.viewport,
    user: r.user_info,
    sizeBytes: Number(r.size_bytes)
  }
}

function checkIds(appId, sessionId) {
  if (!ID_RE.test(appId) || !ID_RE.test(sessionId)) throw new Error('invalid id')
}

/**
 * Postgres store: lets any number of server instances share sessions and archived assets.
 * Event batches are stored gzip-compressed; session summaries are merged atomically in SQL.
 */
class PgStore {
  constructor(connectionString, { poolSize } = {}) {
    const { Pool } = require('pg')
    this.pool = new Pool({ connectionString, max: poolSize || 10 })
    this.pool.on('error', () => {}) // idle client errors are retried on next checkout
  }

  async init() {
    const client = await this.pool.connect()
    try {
      // Serialize migrations when several instances start at once.
      await client.query("SELECT pg_advisory_lock(hashtext('logit_schema'))")
      await client.query(SCHEMA)
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('logit_schema'))").catch(() => {})
      client.release()
    }
  }

  async close() {
    await this.pool.end()
  }

  async drain() {}

  async append(batch) {
    const { appId, sessionId } = batch
    checkIds(appId, sessionId)
    const json = JSON.stringify(batch.events)
    const compressed = await gzip(json)
    const delta = updateMeta(newMeta(appId, sessionId), batch, compressed.length)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(UPSERT, [
        appId, sessionId, delta.startedAt, delta.lastEventAt, delta.receivedAt, delta.eventCount, delta.errorCount,
        delta.failedRequests, delta.slowRequests, delta.pageCount, delta.firstUrl, delta.lastUrl, delta.userAgent,
        delta.viewport ? JSON.stringify(delta.viewport) : null, delta.user ? JSON.stringify(delta.user) : null, delta.sizeBytes
      ])
      await client.query(
        'INSERT INTO logit_batches (app_id, session_id, page_id, seq, received_at, events) VALUES ($1, $2, $3, $4, $5, $6)',
        [appId, sessionId, batch.pageId, batch.seq == null ? null : batch.seq, Date.now(), compressed]
      )
      await client.query('COMMIT')
      return rowToMeta(rows[0])
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  async count() {
    const { rows } = await this.pool.query('SELECT count(*)::int AS n FROM logit_sessions')
    return rows[0].n
  }

  async apps() {
    const { rows } = await this.pool.query(
      'SELECT app_id, count(*)::int AS sessions FROM logit_sessions GROUP BY app_id ORDER BY app_id')
    return rows.map(r => ({ appId: r.app_id, sessions: r.sessions }))
  }

  async list({ appId, q, limit = 50, offset = 0, errorsOnly = false } = {}) {
    const where = []
    const params = []
    if (appId) {
      params.push(appId)
      where.push(`app_id = $${params.length}`)
    }
    if (errorsOnly) where.push('error_count > 0')
    if (q) {
      params.push('%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%')
      const p = `$${params.length}`
      where.push(`(session_id ILIKE ${p} OR first_url ILIKE ${p} OR last_url ILIKE ${p} OR user_info::text ILIKE ${p})`)
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = await this.pool.query(`SELECT count(*)::int AS n FROM logit_sessions ${clause}`, params)
    const page = await this.pool.query(
      `SELECT * FROM logit_sessions ${clause} ORDER BY last_event_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      params.concat([limit, offset]))
    return { total: total.rows[0].n, sessions: page.rows.map(rowToMeta) }
  }

  async getMeta(appId, sessionId) {
    checkIds(appId, sessionId)
    const { rows } = await this.pool.query(
      'SELECT * FROM logit_sessions WHERE app_id = $1 AND session_id = $2', [appId, sessionId])
    return rows[0] ? rowToMeta(rows[0]) : null
  }

  async getEvents(appId, sessionId) {
    checkIds(appId, sessionId)
    const { rows } = await this.pool.query(
      'SELECT events FROM logit_batches WHERE app_id = $1 AND session_id = $2 ORDER BY id', [appId, sessionId])
    if (!rows.length) return (await this.getMeta(appId, sessionId)) ? [] : null
    const events = []
    for (const row of rows) {
      for (const ev of JSON.parse((await gunzip(row.events)).toString('utf8'))) events.push(ev)
    }
    return events
  }

  async delete(appId, sessionId) {
    checkIds(appId, sessionId)
    const { rowCount } = await this.pool.query(
      'DELETE FROM logit_sessions WHERE app_id = $1 AND session_id = $2', [appId, sessionId])
    return rowCount > 0
  }

  async prune(maxAgeMs) {
    const { rowCount } = await this.pool.query('DELETE FROM logit_sessions WHERE last_event_at < $1', [Date.now() - maxAgeMs])
    return rowCount
  }

  // ---------------------------------------------------------------- assets

  async hasAsset(hash) {
    if (!ASSET_ID_RE.test(hash)) return false
    const { rowCount } = await this.pool.query('SELECT 1 FROM logit_assets WHERE hash = $1', [hash])
    return rowCount > 0
  }

  async putAsset(hash, contentType, body) {
    if (!ASSET_ID_RE.test(hash)) throw new Error('invalid asset id')
    await this.pool.query(
      'INSERT INTO logit_assets (hash, content_type, body, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (hash) DO NOTHING',
      [hash, contentType, body, Date.now()])
  }

  async getAsset(hash) {
    if (!ASSET_ID_RE.test(hash)) return null
    const { rows } = await this.pool.query('SELECT content_type, body FROM logit_assets WHERE hash = $1', [hash])
    return rows[0] ? { contentType: rows[0].content_type, body: rows[0].body } : null
  }

  async addSessionAssets(appId, sessionId, map) {
    checkIds(appId, sessionId)
    const urls = Object.keys(map)
    if (!urls.length) return
    try {
      await this.pool.query(
        `INSERT INTO logit_session_assets (app_id, session_id, url, hash)
         SELECT $1, $2, u.url, u.hash FROM unnest($3::text[], $4::text[]) AS u(url, hash)
         ON CONFLICT (app_id, session_id, url) DO UPDATE SET hash = EXCLUDED.hash`,
        [appId, sessionId, urls, urls.map(u => map[u])])
    } catch (e) {
      if (e.code !== '23503') throw e // session deleted meanwhile (foreign key violation)
    }
  }

  async getSessionAssets(appId, sessionId) {
    checkIds(appId, sessionId)
    const { rows } = await this.pool.query(
      'SELECT url, hash FROM logit_session_assets WHERE app_id = $1 AND session_id = $2', [appId, sessionId])
    const map = {}
    for (const r of rows) map[r.url] = r.hash
    return map
  }

  async gcAssets(graceMs) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM logit_assets a WHERE a.created_at < $1
         AND NOT EXISTS (SELECT 1 FROM logit_session_assets sa WHERE sa.hash = a.hash)`,
      [Date.now() - graceMs])
    return rowCount
  }
}

module.exports = { PgStore }
