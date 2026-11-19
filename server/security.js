import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pool, verifyPassword, changeCredentials } from './db.js'

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? '.data')
const COOKIE = 'chat_server_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
export const SESSION_RENEW_WINDOW_SECONDS = 60 * 60 * 24 * 7
const pairCodes = new Map()
let appSecretPromise

async function appSecret() {
  if (!appSecretPromise) {
    appSecretPromise = (async () => {
      if (process.env.APP_SECRET) {
        return Buffer.from(process.env.APP_SECRET, 'utf8')
      }
      const file = path.join(DATA_DIR, 'app-secret')
      await mkdir(DATA_DIR, { recursive: true })
      try {
        return Buffer.from((await readFile(file, 'utf8')).trim(), 'base64url')
      } catch {
        const secret = randomBytes(48)
        await writeFile(file, secret.toString('base64url'), { mode: 0o600, flag: 'wx' }).catch(
          async (error) => {
            if (error.code !== 'EEXIST') {
              throw error
            }
          }
        )
        return Buffer.from((await readFile(file, 'utf8')).trim(), 'base64url')
      }
    })()
  }
  return appSecretPromise
}

const keyFor = async (purpose) =>
  createHash('sha256')
    .update(await appSecret())
    .update(purpose)
    .digest()

export async function encryptSecret(value) {
  const { createCipheriv } = await import('node:crypto')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', await keyFor('encryption-v1'), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`
}

export async function decryptSecret(value) {
  if (!value) {
    return null
  }
  const [version, ivText, tagText, payloadText] = value.split(':')
  if (version !== 'v1' || !ivText || !tagText || payloadText === undefined) {
    throw new Error('Unsupported encrypted secret format')
  }
  const { createDecipheriv } = await import('node:crypto')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    await keyFor('encryption-v1'),
    Buffer.from(ivText, 'base64url')
  )
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(payloadText, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

const sign = async (value) =>
  createHmac('sha256', await keyFor('session-v1'))
    .update(value)
    .digest('base64url')

export async function createSessionCookie(user) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, username: user.username, exp: expiresAt })
  ).toString('base64url')
  const token = `${payload}.${await sign(payload)}`
  const sameSite = process.env.COOKIE_SECURE === 'true' ? 'None' : 'Lax'
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${SESSION_TTL_SECONDS}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`
}

export const clearSessionCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=${process.env.COOKIE_SECURE === 'true' ? 'None' : 'Lax'}; Max-Age=0${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`

async function userFromCookie(request) {
  const cookieHeader = request.headers.cookie ?? ''
  const token = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1)
  if (!token) {
    return null
  }
  const [payload, signature] = token.split('.')
  if (!payload || !signature) {
    return null
  }
  const expected = await sign(payload)
  const actualBytes = Buffer.from(signature)
  const expectedBytes = Buffer.from(expected)
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return null
  }
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!session.id || !session.exp || session.exp < Date.now() / 1000) {
      return null
    }
    const { rows } = await pool.query(
      'SELECT id,username,must_change_password FROM users WHERE id=$1',
      [session.id]
    )
    const row = rows[0]
    return row
      ? {
          id: row.id,
          username: row.username,
          mustChangePassword: Boolean(row.must_change_password),
          cookieAuth: true,
          sessionExpiresAt: session.exp,
        }
      : null
  } catch {
    return null
  }
}

async function userFromBearer(request) {
  const authorization = request.headers.authorization ?? ''
  if (!authorization.startsWith('Bearer ')) {
    return null
  }
  const token = authorization.slice(7).trim()
  if (!token) {
    return null
  }
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const { rows } = await pool.query(
    `SELECT u.id,u.username,u.must_change_password FROM api_tokens t
     JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.expires_at>$2`,
    [tokenHash, Date.now()]
  )
  const row = rows[0]
  return row
    ? {
        id: row.id,
        username: row.username,
        mustChangePassword: Boolean(row.must_change_password),
        tokenAuth: true,
        tokenHash,
      }
    : null
}

export async function authenticatedUser(request) {
  return (await userFromBearer(request)) ?? (await userFromCookie(request))
}

export async function login(username, password) {
  return verifyPassword(username, password)
}

export async function updatePassword(userId, current, next) {
  if (typeof current !== 'string' || !current) {
    return { ok: false, message: 'Current password is required.' }
  }
  if (typeof next !== 'string' || next.length < 8 || next.length > 256) {
    return { ok: false, message: 'Password must contain 8–256 characters.' }
  }
  if (next === 'admin123') {
    return { ok: false, message: 'Choose a password other than the first-run password.' }
  }
  return changeCredentials(userId, current, null, next)
}

export async function updateCredentials(userId, current, username, nextPassword) {
  if (typeof current !== 'string' || !current) {
    return { ok: false, message: 'Current password is required.' }
  }
  if (nextPassword !== undefined && nextPassword !== null && nextPassword !== '') {
    if (typeof nextPassword !== 'string' || nextPassword.length < 8 || nextPassword.length > 256) {
      return { ok: false, message: 'Password must contain 8–256 characters.' }
    }
    if (nextPassword === 'admin123') {
      return { ok: false, message: 'Choose a password other than the first-run password.' }
    }
  }
  return changeCredentials(userId, current, username, nextPassword || null)
}

export async function issueBrowserToken(userId) {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const expiresAt = Date.now() + 12 * 60 * 60_000
  await pool.query(
    'INSERT INTO api_tokens(id,user_id,token_hash,label,expires_at) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), userId, tokenHash, 'DSH browser session', expiresAt]
  )
  return { token, expiresAt: new Date(expiresAt).toISOString() }
}

export function issuePairCode(userId) {
  const code = randomBytes(18).toString('base64url')
  const expiresAt = Date.now() + 5 * 60_000
  pairCodes.set(code, { userId, expiresAt })
  for (const [candidate, entry] of pairCodes) {
    if (entry.expiresAt < Date.now()) {
      pairCodes.delete(candidate)
    }
  }
  return { pairCode: code, expiresAt: new Date(expiresAt).toISOString() }
}

export async function redeemPairCode(pairCode) {
  const entry = pairCodes.get(pairCode)
  pairCodes.delete(pairCode)
  if (!entry || entry.expiresAt < Date.now()) {
    return null
  }
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const expiresAt = Date.now() + 365 * 24 * 60 * 60_000
  await pool.query(
    'INSERT INTO api_tokens(id,user_id,token_hash,label,expires_at) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), entry.userId, tokenHash, 'DSH plugin', expiresAt]
  )
  return { token, expiresAt: new Date(expiresAt).toISOString() }
}

export async function getDeepSeekApiKey(userId) {
  const { rows } = await pool.query(
    'SELECT encrypted_value FROM user_settings WHERE user_id=$1 AND setting_key=$2',
    [userId, 'deepseekApiKey']
  )
  if (rows[0]) {
    return decryptSecret(rows[0].encrypted_value)
  }
  return process.env.DEEPSEEK_API_KEY ?? null
}

export async function setDeepSeekApiKey(userId, value) {
  const encrypted = await encryptSecret(value)
  await pool.query(
    `INSERT INTO user_settings(user_id,setting_key,encrypted_value) VALUES($1,'deepseekApiKey',$2)
     ON CONFLICT(user_id,setting_key) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,updated_at=now()`,
    [userId, encrypted]
  )
}

export const sessionCookieName = COOKIE
