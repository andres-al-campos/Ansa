import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Outliner from './Outliner'
import AuthGate from './AuthGate'
import { seedTree } from '@shared/seed'
import { loadTree } from './storage'
import './index.css'

// First paint only. The server is the source of truth and the app adopts its
// tree the moment the WebSocket connects; this localStorage cache
// (or the seed, on a first-ever visit) just avoids a blank frame before that
// first message arrives, and is what shows if the server is unreachable.
const initial = loadTree() ?? seedTree()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <Outliner initial={initial} />
    </AuthGate>
  </StrictMode>,
)
