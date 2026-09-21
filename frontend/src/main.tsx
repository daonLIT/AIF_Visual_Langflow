import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { configureWorkbench } from '@aif/workbench'
import './host.css'
import App from './App.tsx'
import { hasScope, useSession } from './auth/session'

// 웹은 같은 출처의 /api 를 쿠키 세션으로 부른다. 상태를 바꾸는 요청에는 CSRF 토큰을 붙이고, 401 이면 로그인 화면으로.
function applyHost() {
  configureWorkbench({
    apiBase: '',
    credentials: 'same-origin',
    // 사이트에서 직접 분석하는 버튼은 분석 권한이 있는 계정에만 보인다.
    analysis: hasScope(useSession.getState(), 'analysis:run'),
    extraHeaders: (): Record<string, string> => {
      const token = useSession.getState().csrfToken
      return token ? { 'X-CSRF-Token': token } : {}
    },
    onAuthRequired: () => useSession.getState().markSignedOut(),
  })
}
applyHost()
useSession.subscribe((state, previous) => {
  if (state.scopes !== previous.scopes || state.authMode !== previous.authMode) applyHost()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
