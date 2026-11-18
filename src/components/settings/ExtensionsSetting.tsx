import { useCallback, useEffect, useRef, useState } from 'react'
import { zipSync } from 'fflate'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import styles from './ExtensionsSetting.module.css'

type Section = 'mcp' | 'skills' | 'dsh'
type McpServer = {
  id: string
  name: string
  transport: string
  config: { url?: string; command?: string; args?: string[] }
  enabled: boolean
}
type Skill = { name: string; description: string; source: string }

const requestJson = async (url: string, init: RequestInit = {}) => {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  const result = await response.json()
  if (!response.ok) {
    throw new Error(result.error?.message ?? `Request failed (${response.status})`)
  }
  return result
}

export const ExtensionsSetting = ({ section }: { section: Section }) => {
  const t = useTranslate()
  const [servers, setServers] = useState<McpServer[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [probes, setProbes] = useState<
    Record<
      string,
      { serverInfo?: { name: string }; tools: { name: string; description?: string }[] }
    >
  >({})
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'streamable-http' | 'stdio'>('streamable-http')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [envJson, setEnvJson] = useState('')
  const [token, setToken] = useState('')
  const [pairCode, setPairCode] = useState('')
  const [pairExpiresAt, setPairExpiresAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const folderInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    if (section === 'mcp') {
      setServers(await requestJson('/api/v1/mcp/servers'))
    }
    if (section === 'skills') {
      setSkills(await requestJson('/api/v1/skills'))
    }
  }, [section])

  useEffect(() => {
    void refresh().catch((error) => setStatus(error.message))
  }, [refresh])

  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '')
    folderInput.current?.setAttribute('directory', '')
  }, [])

  const run = async (work: () => Promise<void>) => {
    if (busy) {
      return
    }
    setBusy(true)
    setStatus('')
    try {
      await work()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Request failed.')
    } finally {
      setBusy(false)
    }
  }

  const generatePairCode = () =>
    run(async () => {
      const result = await requestJson('/api/v1/dsh/pair-codes', { method: 'POST', body: '{}' })
      setPairCode(result.pairCode)
      setPairExpiresAt(result.expiresAt)
    })

  const addServer = () =>
    run(async () => {
      if (!name.trim() || (transport === 'streamable-http' ? !url.trim() : !command.trim())) {
        return
      }
      let secrets: Record<string, unknown> | undefined
      if (transport === 'streamable-http' && token) {
        secrets = { headers: { Authorization: `Bearer ${token}` } }
      }
      if (transport === 'stdio' && envJson.trim()) {
        const parsed: unknown = JSON.parse(envJson)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('stdio secrets must be a JSON object.')
        }
        secrets = { env: parsed }
      }
      const config =
        transport === 'streamable-http'
          ? { url: url.trim() }
          : {
              command: command.trim(),
              args: args
                .split(/\r?\n/)
                .map((arg) => arg.trim())
                .filter(Boolean),
              cwd: '/data',
            }
      await requestJson('/api/v1/mcp/servers', {
        method: 'POST',
        body: JSON.stringify({
          id: crypto.randomUUID(),
          name: name.trim(),
          transport,
          config,
          enabled: false,
          ...(secrets ? { secrets } : {}),
        }),
      })
      setName('')
      setUrl('')
      setCommand('')
      setArgs('')
      setEnvJson('')
      setToken('')
      await refresh()
    })

  const toggleServer = (server: McpServer) =>
    run(async () => {
      await requestJson(`/api/v1/mcp/servers/${encodeURIComponent(server.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !server.enabled }),
      })
      await refresh()
    })

  const removeServer = (server: McpServer) =>
    run(async () => {
      await requestJson(`/api/v1/mcp/servers/${encodeURIComponent(server.id)}`, {
        method: 'DELETE',
      })
      setProbes((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => key !== server.id))
      )
      await refresh()
    })

  const probeServer = (server: McpServer) =>
    run(async () => {
      const result = await requestJson(
        `/api/v1/mcp/servers/${encodeURIComponent(server.id)}/probe`,
        { method: 'POST', body: '{}' }
      )
      setProbes((current) => ({ ...current, [server.id]: result }))
    })

  const importSkillFolder = (files: File[]) =>
    run(async () => {
      if (!files.length) {
        return
      }
      if (files.length > 256) {
        throw new Error('Skill folder contains too many files (maximum 256).')
      }
      const entries: Record<string, Uint8Array> = {}
      let totalBytes = 0
      for (const file of files) {
        const relativePath =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        const safePath = relativePath.replaceAll('\\', '/').replace(/^\.\//, '')
        if (
          !safePath ||
          safePath.startsWith('/') ||
          safePath.split('/').some((part) => part === '..')
        ) {
          throw new Error('Skill folder contains an invalid path.')
        }
        const parts = safePath.split('/')
        if (
          parts.some(
            (part) => part.startsWith('.') || part === 'node_modules' || part === '__MACOSX'
          )
        ) {
          continue
        }
        totalBytes += file.size
        if (totalBytes > 25 * 1024 * 1024) {
          throw new Error('Skill folder exceeds 25 MB.')
        }
        entries[safePath] = new Uint8Array(await file.arrayBuffer())
      }
      if (Object.keys(entries).length === 0) {
        throw new Error(t('skillFolderEmpty'))
      }
      const archive = zipSync(entries, { level: 6 })
      const form = new FormData()
      form.append('file', new Blob([archive], { type: 'application/zip' }), 'skills-folder.zip')
      const response = await fetch('/api/v1/skills/import', {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      })
      const result = await response.json()
      if (!response.ok) {
        const code = result.error?.code
        if (code === 'skill_folder_missing_manifest' || code === 'skill_folder_empty') {
          throw new Error(t('skillFolderEmpty'))
        }
        throw new Error(
          t('skillFolderFailed', {
            message: result.error?.message ?? `Request failed (${response.status})`,
          })
        )
      }
      setStatus(t('skillsImported', { count: result.imported?.length ?? 0 }))
      await refresh()
    })

  const removeSkill = (skill: Skill) =>
    run(async () => {
      await requestJson(`/api/v1/skills/${encodeURIComponent(skill.name)}`, { method: 'DELETE' })
      await refresh()
    })

  const addressOf = (server: McpServer) =>
    server.config.url ??
    [server.config.command, ...(server.config.args ?? [])].filter(Boolean).join(' ')

  return (
    <div className={styles.root}>
      {section === 'mcp' ? (
        <section className={styles.group} aria-labelledby="mcp-title">
          <div className={styles.heading}>
            <h3 id="mcp-title">{t('mcpServers')}</h3>
            <p>{t('mcpSettingsDescription')}</p>
          </div>
          {servers.length === 0 ? <p className={styles.description}>{t('mcpNoServers')}</p> : null}
          {servers.map((server) => (
            <div className={styles.serverItem} key={server.id}>
              <div className={styles.row}>
                <div className={styles.itemText}>
                  <strong>{server.name}</strong>
                  <span>{addressOf(server) || server.transport}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={server.enabled}
                  disabled={busy}
                  onClick={() => void toggleServer(server)}
                >
                  {server.enabled ? t('on') : t('off')}
                </button>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={busy}
                  onClick={() => void probeServer(server)}
                >
                  {t('mcpProbe')}
                </Button>
                <Button
                  variant="dangerOutlined"
                  size="s"
                  disabled={busy}
                  onClick={() => void removeServer(server)}
                >
                  {t('mcpRemoveServer')}
                </Button>
              </div>
              {probes[server.id] ? (
                <div className={styles.tools}>
                  {probes[server.id].serverInfo?.name ? (
                    <strong>{probes[server.id].serverInfo?.name}</strong>
                  ) : null}
                  {probes[server.id].tools.map((tool) => (
                    <span key={tool.name}>{tool.name}</span>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          <div className={styles.form}>
            <input
              aria-label={t('mcpServerName')}
              placeholder={t('mcpServerName')}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Select
              ariaLabel={t('mcpTransport')}
              value={transport}
              options={[
                { value: 'streamable-http', label: t('mcpStreamableHttp') },
                { value: 'stdio', label: t('mcpStdio') },
              ]}
              onChange={setTransport}
              className={styles.formSelect}
            />
            {transport === 'streamable-http' ? (
              <>
                <input
                  aria-label={t('mcpServerUrl')}
                  placeholder="https://mcp.example.com/mcp"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
                <input
                  aria-label="Bearer token"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Bearer token (optional)"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </>
            ) : (
              <>
                <input
                  aria-label={t('mcpCommand')}
                  placeholder="uvx"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
                <textarea
                  aria-label={t('mcpArgs')}
                  placeholder={t('mcpArgs')}
                  rows={3}
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                />
                <textarea
                  aria-label={t('mcpEnv')}
                  placeholder={t('mcpEnv')}
                  rows={3}
                  value={envJson}
                  onChange={(event) => setEnvJson(event.target.value)}
                />
                <small className={styles.description}>{t('mcpStdioHint')}</small>
              </>
            )}
            <Button
              variant="outlined"
              size="m"
              disabled={
                busy ||
                !name.trim() ||
                (transport === 'streamable-http' ? !url.trim() : !command.trim())
              }
              onClick={() => void addServer()}
            >
              {t('mcpAddServer')}
            </Button>
          </div>
        </section>
      ) : null}
      {section === 'skills' ? (
        <section className={styles.group} aria-labelledby="skills-title">
          <div className={styles.heading}>
            <h3 id="skills-title">{t('skills')}</h3>
            <p>{t('skillFolderHint')}</p>
          </div>
          {skills.length === 0 ? <p className={styles.description}>{t('noSkills')}</p> : null}
          {skills.map((skill) => (
            <div className={styles.row} key={skill.name}>
              <div className={styles.itemText}>
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
              </div>
              <Button
                variant="dangerOutlined"
                size="s"
                disabled={busy}
                onClick={() => void removeSkill(skill)}
              >
                {t('skillRemove')}
              </Button>
            </div>
          ))}
          <input
            ref={folderInput}
            className={styles.hiddenInput}
            type="file"
            multiple
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ''
              void importSkillFolder(files)
            }}
          />
          <Button
            variant="outlined"
            size="m"
            disabled={busy}
            onClick={() => folderInput.current?.click()}
          >
            {busy ? t('working') : t('skillFolderImport')}
          </Button>
        </section>
      ) : null}
      {section === 'dsh' ? (
        <section className={styles.group} aria-labelledby="dsh-pairing-title">
          <div className={styles.heading}>
            <h3 id="dsh-pairing-title">{t('dshPairing')}</h3>
            <p>{t('dshPairingDescription')}</p>
          </div>
          <div className={styles.row}>
            <Button
              variant="outlined"
              size="m"
              disabled={busy}
              onClick={() => void generatePairCode()}
            >
              {busy ? t('working') : t('dshGeneratePairingCode')}
            </Button>
            {pairCode ? <code className={styles.pairCode}>{pairCode}</code> : null}
          </div>
          {pairExpiresAt ? (
            <small className={styles.description}>
              {t('dshPairingExpires', {
                time: new Intl.DateTimeFormat().format(new Date(pairExpiresAt)),
              })}
            </small>
          ) : null}
        </section>
      ) : null}
      {status ? (
        <p className={styles.status} role="status">
          {status}
        </p>
      ) : null}
    </div>
  )
}
