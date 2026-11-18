import { useEffect, useMemo, useState } from 'react'
import { getVisibleMessages } from '../../services/chat/branches.js'
import type { Session } from '../../services/chat/types.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './SessionMetrics.module.css'

type MetricSnapshot = {
  generations: number
  prompt_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  avg_first_token_ms: number | null
  avg_tps: number | null
  cache_hit_rate_pct: number | null
  current_prompt_tokens: number | null
  context_window: number | null
}

const formatNumber = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat().format(Math.round(value))

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg
    className={styles.icon}
    viewBox="0 0 16 16"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
)

const TurnsIcon = () => (
  <Icon>
    <path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4 14v-2.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />
  </Icon>
)

const ClockIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 4.8V8l2.2 1.4" />
  </Icon>
)

const BoltIcon = () => (
  <Icon>
    <path d="M9.2 1.8 3.8 9h3.4l-.4 5.2L12.2 7H8.8l.4-5.2Z" />
  </Icon>
)

const TokensIcon = () => (
  <Icon>
    <ellipse cx="8" cy="4" rx="5" ry="2.2" />
    <path d="M3 4v4c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V4M3 8v4c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V8" />
  </Icon>
)

const CacheIcon = () => (
  <Icon>
    <path d="M13 6.2A5.2 5.2 0 0 0 3.4 4.6L2 6.4M3 9.8a5.2 5.2 0 0 0 9.6 1.6L14 9.6" />
    <path d="M2 3v3.4h3.4M14 13V9.6h-3.4" />
  </Icon>
)

const ContextRing = ({ ratio }: { ratio: number | null }) => {
  const value = ratio ?? 0
  const radius = 5.4
  const circumference = 2 * Math.PI * radius
  return (
    <svg className={styles.ring} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r={radius} className={styles.ringTrack} />
      <circle
        cx="8"
        cy="8"
        r={radius}
        className={styles.ringFill}
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, value)))}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

export const SessionMetrics = ({
  session,
  streaming,
}: {
  session: Session
  streaming: boolean
}) => {
  const t = useTranslate()
  const [metrics, setMetrics] = useState<MetricSnapshot | null>(null)
  const turns = useMemo(
    () => getVisibleMessages(session).filter((message) => message.role === 'user').length,
    [session]
  )

  useEffect(() => {
    const controller = new AbortController()
    void fetch(`/api/v1/metrics/sessions/${encodeURIComponent(session.id)}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          return
        }
        setMetrics((await response.json()) as MetricSnapshot)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [session.id, streaming])

  const totalTokens = (metrics?.prompt_tokens ?? 0) + (metrics?.output_tokens ?? 0)
  const contextRatio =
    metrics?.current_prompt_tokens && metrics.context_window
      ? Math.min(1, metrics.current_prompt_tokens / metrics.context_window)
      : null
  const cacheRate = metrics?.cache_hit_rate_pct

  return (
    <div className={styles.metrics} aria-label={t('metricSessionTokens')}>
      <span>
        <TurnsIcon />
        <b>{t('metricTurns')}</b> {formatNumber(turns)}
      </span>
      <span>
        <ClockIcon />
        <b>{t('metricFirstToken')}</b>{' '}
        {metrics?.avg_first_token_ms == null ? '—' : `${Math.round(metrics.avg_first_token_ms)} ms`}
      </span>
      <span>
        <BoltIcon />
        <b>{t('metricTps')}</b> {metrics?.avg_tps == null ? '—' : `${metrics.avg_tps.toFixed(1)}`}
      </span>
      <span>
        <TokensIcon />
        <b>{t('metricSessionTokens')}</b> {formatNumber(totalTokens)}
      </span>
      <span>
        <CacheIcon />
        <b>{t('metricCacheHit')}</b> {cacheRate == null ? '—' : `${cacheRate.toFixed(1)}%`}
      </span>
      <span className={styles.context} title={t('metricContext')}>
        <ContextRing ratio={contextRatio} />
        <b>{t('metricContext')}</b>{' '}
        {contextRatio == null ? '—' : `${Math.round(contextRatio * 100)}%`}
      </span>
    </div>
  )
}
