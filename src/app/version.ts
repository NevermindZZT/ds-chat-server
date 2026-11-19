/** Build-time version injected into index.html by HtmlRspackPlugin. */
export const appVersion =
  document.querySelector('meta[name="application-version"]')?.getAttribute('content') ?? 'dev'
