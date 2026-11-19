import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import { initBrowserToken } from './services/browserToken.js'
import './app/theme.css'
import './app/global.css'

initBrowserToken()
ensureKatex()
setupTheme()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
