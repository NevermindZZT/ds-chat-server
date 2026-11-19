import Database from 'better-sqlite3'
import { randomUUID, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? '.data')
const DB_PATH = path.join(DATA_DIR, 'chat.sqlite')
mkdirSync(DATA_DIR, { recursive: true })

function openDatabase() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  return db
}

function normalizeSql(sql, params) {
  const boundValues = []
  const numbered = sql.replace(/\$([0-9]+)/g, (_match, position) => {
    const value = params[Number(position) - 1]
    boundValues.push(
      typeof value === 'boolean'
        ? Number(value)
        : value instanceof Date
          ? value.toISOString()
          : (value ?? null)
    )
    return '?'
  })
  const normalized = numbered
    .replace(/::\s*(?:jsonb|json|int|integer|float|double precision|boolean|text)\b/gi, '')
    .replace(/\bjsonb\b/gi, 'TEXT')
    .replace(/\buuid\b/gi, 'TEXT')
    .replace(/\bbytea\b/gi, 'BLOB')
    .replace(/\btimestamptz\b/gi, 'TEXT')
    .replace(/\bboolean\b/gi, 'INTEGER')
    .replace(/\bbigint\b/gi, 'INTEGER')
    .replace(/\binteger\b/gi, 'INTEGER')
    .replace(/\bnow\(\)/gi, "strftime('%Y-%m-%dT%H:%M:%fZ','now')")
  return { sql: normalized, params: boundValues }
}

function createQueryApi(db, closeOnRelease = false) {
  return {
    async query(sql, params = []) {
      const normalized = normalizeSql(sql, params)
      if (normalized.params.length === 0 && normalized.sql.includes(';')) {
        db.exec(normalized.sql)
        return { rows: [], rowCount: 0 }
      }
      const statement = db.prepare(normalized.sql)
      if (
        /\bRETURNING\b/i.test(normalized.sql) ||
        /^\s*(SELECT|PRAGMA|WITH)\b/i.test(normalized.sql)
      ) {
        const rows = statement.all(...normalized.params)
        return { rows, rowCount: rows.length }
      }
      const result = statement.run(...normalized.params)
      return {
        rows: [],
        rowCount: Number(result.changes ?? 0),
        lastInsertRowid: result.lastInsertRowid,
      }
    },
    async release() {
      if (closeOnRelease) {
        db.close()
      }
    },
  }
}

const mainDatabase = openDatabase()
const mainClient = createQueryApi(mainDatabase)

/** Async query facade for existing routes; the backing store is a single SQLite file. */
export const pool = {
  query: (sql, params) => mainClient.query(sql, params),
  async connect() {
    const transactionDb = openDatabase()
    return createQueryApi(transactionDb, true)
  },
}

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_salt BLOB NOT NULL,
      password_hash BLOB NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      setting_key TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, setting_key)
    );
    CREATE TABLE IF NOT EXISTS chat_sessions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      data TEXT NOT NULL,
      PRIMARY KEY (user_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS chat_sessions_updated_idx ON chat_sessions(user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS attachments (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL,
      provider_file_id TEXT,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      byte_size INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, attachment_id)
    );
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT,
      model TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      first_content_ms INTEGER,
      duration_ms INTEGER,
      generation_time_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      context_window INTEGER,
      status TEXT NOT NULL DEFAULT 'running'
    );
    CREATE INDEX IF NOT EXISTS generations_session_idx ON generations(user_id, session_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS mcp_servers (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      transport TEXT NOT NULL,
      config TEXT NOT NULL,
      encrypted_secrets TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, server_id)
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `)
  const generationColumns = mainDatabase.pragma('table_info(generations)')
  if (!generationColumns.some((column) => column.name === 'generation_time_ms')) {
    mainDatabase.exec('ALTER TABLE generations ADD COLUMN generation_time_ms INTEGER')
  }
  await ensureInitialAdmin()
}

async function ensureInitialAdmin() {
  const username = process.env.ADMIN_USERNAME ?? 'admin'
  const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username])
  if (existing.rowCount) {
    return
  }
  const password = process.env.ADMIN_PASSWORD ?? 'admin123'
  const salt = randomBytes(16)
  const hash = Buffer.from(await scrypt(password, salt, 64))
  await pool.query(
    'INSERT INTO users (id, username, password_salt, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), username, salt, hash, password === 'admin123']
  )
  if (password === 'admin123') {
    process.stderr.write(
      'Using the first-run password admin/admin123; change it before exposing this service.\n'
    )
  }
}

export async function verifyPassword(username, password) {
  const { rows } = await pool.query(
    'SELECT id, username, password_salt, password_hash, must_change_password FROM users WHERE username=$1',
    [username]
  )
  const user = rows[0]
  if (!user) {
    await scrypt(password, Buffer.alloc(16), 64)
    return null
  }
  const candidate = Buffer.from(await scrypt(password, user.password_salt, 64))
  if (!timingSafeEqual(candidate, user.password_hash)) {
    return null
  }
  return {
    id: user.id,
    username: user.username,
    mustChangePassword: Boolean(user.must_change_password),
  }
}

export async function changeCredentials(userId, currentPassword, nextUsername, nextPassword) {
  const { rows } = await pool.query('SELECT username FROM users WHERE id=$1', [userId])
  const current = rows[0]
  if (!current || !(await verifyPassword(current.username, currentPassword))) {
    return { ok: false, message: 'Current password is incorrect.' }
  }
  const username = nextUsername?.trim() || current.username
  if (username !== current.username) {
    if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
      return {
        ok: false,
        message: 'Username must contain 3–64 letters, numbers, dots, underscores, or hyphens.',
      }
    }
    const { rows: taken } = await pool.query(
      'SELECT id FROM users WHERE username=$1 AND id<>$2',
      [username, userId]
    )
    if (taken[0]) {
      return { ok: false, message: 'That username is already in use.' }
    }
    await pool.query('UPDATE users SET username=$2 WHERE id=$1', [userId, username])
  }
  if (nextPassword) {
    const salt = randomBytes(16)
    const hash = Buffer.from(await scrypt(nextPassword, salt, 64))
    await pool.query(
      'UPDATE users SET password_salt=$2,password_hash=$3,must_change_password=0 WHERE id=$1',
      [userId, salt, hash]
    )
  }
  return { ok: true, username }
}

export async function changePassword(userId, currentPassword, nextPassword) {
  const result = await changeCredentials(userId, currentPassword, null, nextPassword)
  return result.ok ? true : false
}

export async function getSetting(userId, key) {
  const { rows } = await pool.query(
    'SELECT encrypted_value FROM user_settings WHERE user_id=$1 AND setting_key=$2',
    [userId, key]
  )
  return rows[0]?.encrypted_value ?? null
}

export async function setSetting(userId, key, encryptedValue) {
  await pool.query(
    `INSERT INTO user_settings(user_id,setting_key,encrypted_value) VALUES($1,$2,$3)
     ON CONFLICT(user_id,setting_key) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [userId, key, encryptedValue]
  )
}

export async function listSessions(userId) {
  const { rows } = await pool.query(
    'SELECT session_id AS id,title,created_at AS "createdAt",updated_at AS "updatedAt",revision FROM chat_sessions WHERE user_id=$1 ORDER BY updated_at DESC',
    [userId]
  )
  return rows
}

export async function getSession(userId, sessionId) {
  const { rows } = await pool.query(
    'SELECT data,revision FROM chat_sessions WHERE user_id=$1 AND session_id=$2',
    [userId, sessionId]
  )
  const row = rows[0]
  if (!row) {
    return null
  }
  return { ...row, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data }
}

export async function saveSession(userId, session) {
  const { rows } = await pool.query(
    `INSERT INTO chat_sessions(user_id,session_id,title,created_at,updated_at,data)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(user_id,session_id) DO UPDATE SET title=EXCLUDED.title,updated_at=EXCLUDED.updated_at,
       data=EXCLUDED.data,revision=chat_sessions.revision+1
     RETURNING revision`,
    [
      userId,
      session.id,
      session.title ?? '',
      session.createdAt ?? Date.now(),
      session.updatedAt ?? Date.now(),
      JSON.stringify(session),
    ]
  )
  return rows[0].revision
}

export async function deleteSession(userId, sessionId) {
  const { rowCount } = await pool.query(
    'DELETE FROM chat_sessions WHERE user_id=$1 AND session_id=$2',
    [userId, sessionId]
  )
  return rowCount > 0
}

export async function saveGenerationMetric(metric) {
  await pool.query(
    `UPDATE generations SET first_content_ms=$2,duration_ms=$3,input_tokens=$4,output_tokens=$5,
       cache_creation_input_tokens=$6,cache_read_input_tokens=$7,context_window=$8,status=$9 WHERE id=$1`,
    [
      metric.id,
      metric.firstContentMs,
      metric.durationMs,
      metric.inputTokens,
      metric.outputTokens,
      metric.cacheCreationInputTokens,
      metric.cacheReadInputTokens,
      metric.contextWindow,
      metric.status,
    ]
  )
}
