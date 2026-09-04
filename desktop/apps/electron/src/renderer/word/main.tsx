import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { SessionWordEditor } from '@/components/word/SessionWordEditor'
import { i18n } from '@/lib/i18n'
import '../index.css'

const params = new URLSearchParams(window.location.search)
const sessionId = params.get('sessionId')?.trim()
if (!sessionId) throw new Error('Word renderer requires a Session id.')

const locale = params.get('locale')?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.dataset.theme = theme
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
void i18n.changeLanguage(locale)

const root = document.getElementById('word-root')
if (!root) throw new Error('#word-root not found in word.html')

createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <SessionWordEditor
        defaultTitle={i18n.t('word.untitled')}
        expanded
        sessionId={sessionId}
        showExpandControl={false}
      />
    </I18nextProvider>
  </StrictMode>,
)
