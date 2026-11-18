import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import settingStyles from './Settings.module.css'
import styles from './ContextCompactionSetting.module.css'

type Settings = {
  autoEnabled: boolean
  triggerRatio: number
  targetRatio: number
  retainRecentTurns: number
}

const DEFAULTS: Settings = {
  autoEnabled: true,
  triggerRatio: 0.8,
  targetRatio: 0.55,
  retainRecentTurns: 4,
}

export const ContextCompactionSetting = () => {
  const t = useTranslate()
  const [settings, setSettings] = useState(DEFAULTS)
  const [status, setStatus] = useState('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveController = useRef<AbortController | null>(null)
  const revision = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/v1/settings', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Unable to load compaction settings.')
        }
        const result = await response.json()
        setSettings({ ...DEFAULTS, ...result.compaction })
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setStatus(error instanceof Error ? error.message : t('contextCompactionFailed'))
        }
      })
    return () => {
      controller.abort()
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
      }
      saveController.current?.abort()
    }
  }, [t])

  const update = (next: Settings) => {
    setSettings(next)
    setStatus(t('contextSaving'))
    const currentRevision = ++revision.current
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
    }
    saveController.current?.abort()
    saveTimer.current = setTimeout(async () => {
      const controller = new AbortController()
      saveController.current = controller
      try {
        const response = await fetch('/api/v1/settings/compaction', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
          signal: controller.signal,
        })
        const result = await response.json()
        if (!response.ok) {
          throw new Error(result.error?.message ?? t('contextCompactionFailed'))
        }
        if (currentRevision === revision.current) {
          setSettings(result.compaction)
          setStatus(t('contextSaved'))
        }
      } catch (error) {
        if (!controller.signal.aborted && currentRevision === revision.current) {
          setStatus(error instanceof Error ? error.message : t('contextCompactionFailed'))
        }
      } finally {
        if (saveController.current === controller) {
          saveController.current = null
        }
      }
    }, 450)
  }

  const range = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void,
    display: string
  ) => (
    <div className={`${settingStyles.cell} ${styles.rangeCell}`}>
      <div className={styles.rangeLabel}>
        <span className={settingStyles.label}>{label}</span>
        <b>{display}</b>
      </div>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )

  return (
    <div className={styles.list} aria-labelledby="context-compaction-title">
      <div className={settingStyles.cell}>
        <div className={settingStyles.label} id="context-compaction-title">
          {t('contextCompactionSettings')}
        </div>
        <div className={settingStyles.description}>{t('contextCompactionDescription')}</div>
      </div>
      <div className={`${settingStyles.cell} ${styles.toggleCell}`}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={settings.autoEnabled}
            onChange={(event) => update({ ...settings, autoEnabled: event.target.checked })}
          />
          <span>{t('contextAutoEnabled')}</span>
        </label>
      </div>
      {range(
        t('contextTriggerRatio'),
        Math.round(settings.triggerRatio * 100),
        50,
        95,
        1,
        (value) => update({ ...settings, triggerRatio: value / 100 }),
        `${Math.round(settings.triggerRatio * 100)}%`
      )}
      {range(
        t('contextTargetRatio'),
        Math.round(settings.targetRatio * 100),
        25,
        75,
        1,
        (value) => update({ ...settings, targetRatio: value / 100 }),
        `${Math.round(settings.targetRatio * 100)}%`
      )}
      {range(
        t('contextRecentTurns'),
        settings.retainRecentTurns,
        1,
        12,
        1,
        (value) => update({ ...settings, retainRecentTurns: value }),
        String(settings.retainRecentTurns)
      )}
      <div className={`${settingStyles.cell} ${styles.status}`} role="status" aria-live="polite">
        {status}
      </div>
    </div>
  )
}
