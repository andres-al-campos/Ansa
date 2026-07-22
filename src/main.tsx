import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Outliner from './Outliner'
import { seedTree } from './seed'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Outliner initial={seedTree()} />
  </StrictMode>,
)
