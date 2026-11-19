const STORAGE_KEY = 'dsh-chat-browser-token'

let token: string | null = null

/**
 * DSH 嵌入 iframe 时，跨站 Cookie 可能被浏览器拦截。Host 会签发一个短期
 * Bearer token，通过 URL fragment 传入；随后所有同源 /api 请求自动携带它。
 * fragment 不会发送给服务器，也不会出现在 Referer 中，读取后立即从地址栏移除。
 */
export function initBrowserToken() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''))
  const fromHash = hash.get('dshToken')
  if (fromHash) {
    token = fromHash
    sessionStorage.setItem(STORAGE_KEY, fromHash)
    history.replaceState(null, '', `${location.pathname}${location.search}`)
  } else {
    token = sessionStorage.getItem(STORAGE_KEY)
  }
  if (!token) {
    return
  }
  const originalFetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, location.href)
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
      return originalFetch(input, init)
    }
    const headers = new Headers(init?.headers)
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    return originalFetch(input, { ...init, headers })
  }
}

export const hasBrowserToken = () => Boolean(token)
