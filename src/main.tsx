import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Outliner from './Outliner'
import { seedTree } from './seed'
import { loadTree } from './storage'
import './index.css'

// A saved tree wins; the seed is only for a first-ever visit (or unreadable
// storage). Falling back to the seed rather than an empty list keeps a fresh
// browser from opening onto a blank screen.
const initial = loadTree() ?? seedTree()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Outliner initial={initial} />
  </StrictMode>,
)
