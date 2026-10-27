// Law: nothing scrolls on both axes at once, and the page never scrolls
// sideways. On a phone either one always looks broken.
//
// Measured on the rendered app at a phone and a desktop width, on Home and on
// an open project, against the no-sign-in stack (./build.sh check --drives starts it).
// Don't fix a failure with a global `overflow-x: hidden`; that hides the
// overflow and breaks sticky positioning. Fix the wide element.
//
//   node tests/no-two-axis-scroll.mjs
import { chromium } from 'playwright'

const APP = process.env.ANSA_APP ?? 'http://localhost:5173'
const API = process.env.ANSA_API ?? 'http://127.0.0.1:8787'
const widths = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 800 },
]

const api = (path, init = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: { 'x-ansa-user': 'dev', ...(init.body ? { 'content-type': 'application/json' } : {}) },
  }).then((r) => {
    if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${r.status}`)
    return r.json()
  })

const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => null)
if (health?.auth !== 'dev') {
  console.error(`The local stack isn't up without sign-in (${API}/api/health said ${JSON.stringify(health)}).`)
  console.error('Start it with ./build.sh web --no-auth, then rerun.')
  process.exit(1)
}

// A long word and a deep outline, the content most likely to push something
// wide, under enough rows to scroll down: a list that fits on one screen
// scrolls on neither axis, so it can't show a second one.
const project = `law two-axis ${Date.now()}`
const long = 'Supercalifragilisticexpialidocious'.repeat(4)
const filler = Array.from({ length: 30 }, (_, i) => ({ text: `Task ${i + 1}` }))
const { ids } = await api('/api/nodes/subtree', {
  method: 'POST',
  body: JSON.stringify({
    parentId: null,
    nodes: [{ text: project, children: [{ text: long, children: [{ text: 'Deep', children: [{ text: 'Deeper', children: [{ text: long }] }] }] }, ...filler] }],
  }),
})

function measure() {
  const name = (el) => el.tagName.toLowerCase()
    + (el.id ? `#${el.id}` : '')
    + (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).join('.') : '')
  const problems = []
  const width = window.innerWidth
  if (document.scrollingElement.scrollWidth > width + 1) {
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > width + 1)
      // The outermost culprit only; its children overflow because it does.
      .filter((el) => el.parentElement.getBoundingClientRect().right <= width + 1)
      .slice(0, 3).map(name)
    problems.push(`the page scrolls sideways (${document.scrollingElement.scrollWidth}px of content in a ${width}px window). Wider than the window: ${wide.join(', ')}`)
  }
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el)
    const x = /auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1
    const y = /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1
    if (x && y) problems.push(`${name(el)} scrolls on both axes. Let one axis wrap or truncate.`)
  }
  return problems
}

const problems = []
const browser = await chromium.launch().catch(() => {
  console.error("Playwright's Chromium isn't installed. Run: npx playwright install chromium")
  process.exit(1)
})
try {
  const page = await browser.newPage({ viewport: widths[1] })
  await page.goto(APP)
  const side = page.getByRole('complementary')
  await side.getByRole('button', { name: '+ New project' }).waitFor()
  const where = {
    Home: () => page.getByRole('button', { name: 'Ansa', exact: true }).click(),
    'the project': () => side.getByRole('button', { name: project, exact: true }).click(),
  }
  for (const [label, go] of Object.entries(where)) {
    await page.setViewportSize(widths[1])
    await go()
    await page.waitForTimeout(300)
    for (const w of widths) {
      await page.setViewportSize(w)
      await page.waitForTimeout(300)
      for (const p of await page.evaluate(measure)) problems.push(`${label} @ ${w.name}: ${p}`)
    }
  }
} finally {
  await browser.close()
  await api(`/api/nodes/${ids[0]}`, { method: 'DELETE' }).catch((e) => console.error(`cleanup: ${e.message}`))
}

if (problems.length) {
  console.log('  FAIL  no-two-axis-scroll')
  for (const p of problems) console.log(`          ${p}`)
  process.exit(1)
}
console.log('  ok    no-two-axis-scroll (Home and a project, phone and desktop)')
