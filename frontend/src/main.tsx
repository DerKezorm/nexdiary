import '@fontsource-variable/fraunces'
import '@fontsource-variable/lora'
import '@fontsource-variable/nunito'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import './i18n'
import './index.css'
import { startSharing } from './lib/sharedInbox'
import { followSystem } from './lib/theme'
import { AuthProvider } from './state/auth'

followSystem()
startSharing()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
