import { useEffect, useState, type FormEvent } from 'react'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './AccountSetting.module.css'

type MeResponse = {
  authenticated?: boolean
  user?: { username?: string } | null
}

export const AccountSetting = () => {
  const t = useTranslate()
  const [username, setUsername] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/v1/auth/me', { credentials: 'same-origin' })
        const result = (await response.json()) as MeResponse
        if (!cancelled && result.user?.username) {
          setUsername(result.user.username)
        }
      } catch {
        /* The section stays editable; the server reports the real error on save. */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/v1/auth/change-credentials', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword,
          username,
          newPassword: newPassword || undefined,
        }),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error?.message ?? `HTTP ${response.status}`)
      }
      setCurrentPassword('')
      setNewPassword('')
      if (result.user?.username) {
        setUsername(result.user.username)
      }
      showToast(t('accountUpdated'))
    } catch (reason) {
      setError(
        t('accountUpdateFailed', {
          message: reason instanceof Error ? reason.message : String(reason),
        })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.root}>
      <div className={styles.heading}>
        <h3>{t('account')}</h3>
        <p>{t('accountDescription')}</p>
      </div>
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          {t('username')}
          <input
            autoComplete="username"
            maxLength={64}
            minLength={3}
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <span className={styles.hint}>{t('usernameHint')}</span>
        </label>
        <label className={styles.field}>
          {t('currentPassword')}
          <input
            autoComplete="current-password"
            required
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          {t('newPasswordOptional')}
          <input
            autoComplete="new-password"
            minLength={8}
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <span className={styles.hint}>{t('passwordHint')}</span>
        </label>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <Button disabled={busy} type="submit">
            {busy ? t('working') : t('accountSave')}
          </Button>
        </div>
      </form>
    </section>
  )
}
