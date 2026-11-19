import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { setApiKey } from '../../services/settings.js'
import styles from './AuthGate.module.css'

type User = { id: string; username: string; mustChangePassword: boolean }
type Phase = 'loading' | 'login' | 'password' | 'ready' | 'unavailable'

const chinese =
  typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh')
const text = (zh: string, en: string) => (chinese ? zh : en)

async function loadServerSettings() {
  const response = await fetch('/api/v1/settings', { credentials: 'same-origin' })
  if (!response.ok) {
    throw new Error(`Settings request failed (${response.status})`)
  }
  const value = await response.json()
  setApiKey(value.apiKeyConfigured ? 'configured' : null)
}

export const AuthGate = ({ children }: { children: ReactNode }) => {
  const [phase, setPhase] = useState<Phase>('loading')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const check = async () => {
    setPhase('loading')
    setError('')
    try {
      const response = await fetch('/api/v1/auth/me', { credentials: 'same-origin' })
      if (!response.ok) {
        throw new Error(`Sign-in check failed (${response.status})`)
      }
      const result = await response.json()
      if (!result.authenticated) {
        setPhase('login')
        return
      }
      setUser(result.user)
      if (result.user.mustChangePassword) {
        setPhase('password')
        return
      }
      await loadServerSettings()
      setPhase('ready')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('unavailable')
    }
  }

  useEffect(() => {
    void check()
  }, [])

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error?.message ?? `Sign-in failed (${response.status})`)
      }
      setUser(result.user)
      if (result.user.mustChangePassword) {
        setPhase('password')
      } else {
        try {
          await loadServerSettings()
        } catch (reason) {
          if (String(reason).includes('(401)')) {
            throw new Error(
              text(
                '登录成功，但浏览器未保存会话（401）。请检查 HTTPS/COOKIE_SECURE 配置，或在 DSH 插件中重新配对。',
                'Signed in, but the browser did not keep the session (401). Check HTTPS/COOKIE_SECURE, or re-pair the DSH plugin.'
              )
            )
          }
          throw reason
        }
        setPhase('ready')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/v1/auth/change-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error?.message ?? `Password change failed (${response.status})`)
      }
      setUser((current) => (current ? { ...current, mustChangePassword: false } : current))
      setPassword('')
      setNewPassword('')
      await loadServerSettings()
      setPhase('ready')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'ready') {
    return <>{children}</>
  }
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="auth-title">
        <img className={styles.mark} src="/favicon.svg" alt="" aria-hidden="true" />
        <h1 id="auth-title">{text('DeepSeek Chat', 'DeepSeek Chat')}</h1>
        {phase === 'loading' ? (
          <p role="status">{text('正在连接服务…', 'Connecting to the server…')}</p>
        ) : null}
        {phase === 'unavailable' ? (
          <>
            <p role="alert">{error}</p>
            <button className={styles.primary} type="button" onClick={() => void check()}>
              {text('重试', 'Retry')}
            </button>
          </>
        ) : null}
        {phase === 'login' ? (
          <form onSubmit={submitLogin} className={styles.form}>
            <label>
              {text('用户名', 'Username')}
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label>
              {text('密码', 'Password')}
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <button className={styles.primary} disabled={busy} type="submit">
              {busy ? text('正在登录…', 'Signing in…') : text('登录', 'Sign in')}
            </button>
          </form>
        ) : null}
        {phase === 'password' ? (
          <form onSubmit={submitPassword} className={styles.form}>
            <p>
              {text(
                '首次登录必须设置新密码。新密码至少 8 个字符。',
                'Set a new password before continuing. Use at least 8 characters.'
              )}
            </p>
            <label>
              {text('当前密码', 'Current password')}
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <label>
              {text('新密码', 'New password')}
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </label>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <button className={styles.primary} disabled={busy} type="submit">
              {busy
                ? text('正在保存…', 'Saving…')
                : text('修改密码并继续', 'Change password and continue')}
            </button>
          </form>
        ) : null}
        {phase === 'login' ? (
          <p className={styles.hint}>
            {text(
              '首次启动默认账号：admin / admin123。首次登录后必须立即修改。',
              'First-run account: admin / admin123. You must change it after signing in.'
            )}
          </p>
        ) : null}
        {user && phase === 'password' ? (
          <p className={styles.hint}>
            {text(`正在为 ${user.username} 更新密码。`, `Changing password for ${user.username}.`)}
          </p>
        ) : null}
      </section>
    </main>
  )
}
