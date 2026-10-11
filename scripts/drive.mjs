// Drives Ansa's web features the way a user would, against `./build.sh web
// --no-auth`. Each drive makes its own project and deletes it for good at the
// end, so the local tree is left as it was found. Screenshots and exports land
// in drive-out/ as the evidence.
//
//   npm run drive                 every drive
//   npm run drive -- trash sync   just these
//   npm run drive -- --clean      remove projects left by an interrupted run
import { chromium } from 'playwright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const APP = process.env.ANSA_APP ?? 'http://localhost:5173'
const API = process.env.ANSA_API ?? 'http://127.0.0.1:8787'
const OUT = process.env.DRIVE_OUT ?? `${ROOT}drive-out`
const only = process.argv.slice(2)

// A mistyped name would otherwise filter out every drive and pass. Names are
// read from this file's own text, the way laws/feature-map.mjs reads them.
const known = [...readFileSync(fileURLToPath(import.meta.url), 'utf8').matchAll(/^await drive\('([^']+)'/gm)].map((m) => m[1])
const unknown = only.filter((name) => name !== '--clean' && !known.includes(name))
if (unknown.length) {
  console.error(`No drive named ${unknown.map((name) => `"${name}"`).join(', ')}. Fix the name and rerun.`)
  console.error(`The ones there: ${known.join(', ')}`)
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

const health = await fetch(`${API}/api/health`).then((r) => r.json()).catch(() => null)
if (health?.auth !== 'dev') {
  console.error(`The local stack isn't up in dev auth (${API}/api/health said ${JSON.stringify(health)}).`)
  console.error('Start it with ./build.sh web --no-auth, then rerun.')
  process.exit(1)
}

let browser
try {
  browser = await chromium.launch()
} catch {
  console.error("Playwright's Chromium isn't installed. Run: npx playwright install chromium")
  process.exit(1)
}
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
let failed = 0
let ran = 0

async function newPage() {
  const page = await context.newPage()
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(e.message))
  await page.goto(APP)
  await page.getByRole('complementary').getByRole('button', { name: '+ New project' }).waitFor()
  return page
}

const row = (page, text) => page.locator('.row', { has: page.locator('.label-text', { hasText: new RegExp(`^${text}$`) }) })
const indent = async (page, text) => parseInt(await row(page, text).evaluate((r) => r.style.paddingLeft))
async function expect(cond, message) {
  if (!(await cond)) throw new Error(message)
}
async function until(fn, message, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(message)
}

// A project with Parent > (Child A, Child B), opened.
async function makeProject(page, name) {
  await page.getByRole('complementary').getByRole('button', { name: '+ New project' }).click()
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name, level: 1 }).waitFor()
  await page.keyboard.type('Parent')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Child A')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Child B')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await row(page, 'Child B').waitFor()
}

const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
const sidebar = (page) => page.getByRole('complementary')
const trashEntry = (page, text) => page.locator('.trash-list li', { has: page.locator('.trash-text', { hasText: exactly(text) }) })

async function openTrash(page) {
  await sidebar(page).getByRole('button', { name: 'Trash', exact: true }).click()
  await page.locator('.trash-list, .trash-status').first().waitFor()
  await until(async () => (await page.locator('.trash-status', { hasText: 'Loading' }).count()) === 0, 'Trash never loaded')
}

// Home card's delete moves the project to Trash; Trash's Delete removes it for good.
async function deleteProject(page, name) {
  await page.getByRole('button', { name: 'Ansa', exact: true }).click()
  const card = page.locator('.proj-card', { hasText: name })
  await card.hover()
  await page.getByRole('button', { name: `Delete ${name}`, exact: true }).click()
  await page.getByRole('button', { name: `Confirm delete ${name}`, exact: true }).click()
  await until(async () => (await card.count()) === 0, `${name} still on Home after delete`)
  await openTrash(page)
  await trashEntry(page, name).getByRole('button', { name: 'Delete' }).click()
  await until(async () => (await trashEntry(page, name).count()) === 0, `${name} still in Trash after Delete`)
}

async function drive(name, fn) {
  if (only.length && !only.includes(name)) return
  const project = `drive ${name} ${Date.now()}`
  const page = await newPage()
  ran++
  try {
    await fn(page, project)
    if (page.errors.length) throw new Error(`page threw: ${page.errors.join('; ')}`)
    console.log(`  ok    ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL  ${name}\n          ${e.message.split('\n')[0]}`)
  } finally {
    await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {})
    await deleteProject(page, project).catch((e) => console.log(`        cleanup: ${e.message.split('\n')[0]}`))
    await page.close()
  }
}

if (only[0] === '--clean') {
  // Leftovers from an interrupted run: every project named "drive …".
  const page = await newPage()
  await page.getByRole('button', { name: 'Ansa', exact: true }).click()
  for (const name of await page.locator('.proj-card-title').allTextContents()) {
    if (name.startsWith('drive ')) await deleteProject(page, name).then(() => console.log(`  removed ${name}`))
  }
  await browser.close()
  process.exit(0)
}

await drive('outline', async (page, project) => {
  await makeProject(page, project)
  await expect((await indent(page, 'Child A')) > (await indent(page, 'Parent')), 'Child A is not nested under Parent')
  await page.reload()
  await row(page, 'Child B').waitFor()
  await expect((await indent(page, 'Child B')) > (await indent(page, 'Parent')), 'nesting lost on reload')
})

await drive('check-off', async (page, project) => {
  await makeProject(page, project)
  const parent = page.getByRole('checkbox', { name: 'Parent' })
  await page.getByRole('checkbox', { name: 'Child A' }).click()
  await expect((await parent.getAttribute('aria-checked')) === 'false', 'Parent done with one child open')
  await page.getByRole('checkbox', { name: 'Child B' }).click()
  await until(async () => (await parent.getAttribute('aria-checked')) === 'true', 'Parent not done after both children')
  await page.getByRole('checkbox', { name: 'Child A' }).click()
  await until(async () => (await parent.getAttribute('aria-checked')) === 'false', 'unticking a child left the parent done')
})

await drive('check-off-home', async (page, project) => {
  await makeProject(page, project)
  const meta = async () => {
    await page.getByRole('button', { name: 'Ansa', exact: true }).click()
    const text = await page.locator('.proj-card', { hasText: project }).locator('.proj-card-meta').textContent()
    await sidebar(page).getByRole('button', { name: project, exact: true }).click()
    await row(page, 'Child A').waitFor()
    return text.trim()
  }
  const before = await meta()
  await page.getByRole('checkbox', { name: 'Child A' }).click()
  const half = await meta()
  await page.getByRole('checkbox', { name: 'Child B' }).click()
  const after = await meta()
  console.log(`          Home card: "${before}" → "${half}" → "${after}"`)
  await expect(before !== half && half !== after, 'the Home card count did not move')
})

await drive('reorganize-drag', async (page, project) => {
  await makeProject(page, project)
  const from = await row(page, 'Child B').locator('.bullet').boundingBox()
  const to = await row(page, 'Parent').boundingBox()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(400)
  await page.mouse.move(to.x + to.width / 3, to.y + to.height / 2, { steps: 15 })
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT}/reorganize-mid-drag.png` })
  await page.mouse.up()
  await page.waitForTimeout(500)
  const order = await page.locator('.row .label-text').allTextContents()
  await expect(order.join(',') === 'Parent,Child B,Child A', `order after drag is ${order.join(', ')}`)
  await expect((await indent(page, 'Child B')) > (await indent(page, 'Parent')), 'Child B is not inside Parent')
})

await drive('reorganize-keys', async (page, project) => {
  await makeProject(page, project)
  await row(page, 'Child B').locator('.label-text').click()
  await page.keyboard.press('Alt+ArrowUp')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  let order = await page.locator('.row .label-text').allTextContents()
  await expect(order.join(',') === 'Parent,Child B,Child A', `⌥↑ gave ${order.join(', ')}`)
  await row(page, 'Child B').locator('.label-text').click()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await expect((await indent(page, 'Child B')) === (await indent(page, 'Parent')), 'Shift+Tab did not outdent Child B')
  await page.reload()
  await row(page, 'Child B').waitFor()
  order = await page.locator('.row .label-text').allTextContents()
  await expect(order.indexOf('Child B') > order.indexOf('Parent'), `after reload: ${order.join(', ')}`)
  await expect((await indent(page, 'Child B')) === (await indent(page, 'Parent')), 'outdent lost on reload')
})

await drive('backup', async (page, project) => {
  await makeProject(page, project)
  await page.locator('summary', { hasText: 'Backup & transfer' }).click()
  const exportOnce = async (name) => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()])
    const path = `${OUT}/${name}`
    await download.saveAs(path)
    return path
  }
  const first = await exportOnce('backup-1.json')
  const firstText = readFileSync(first, 'utf8')
  await expect(firstText.includes(project) && firstText.includes('Child B'), 'the export is missing the project')
  page.once('dialog', (d) => d.accept())
  await page.locator('input[type=file]').setInputFiles(first)
  await page.waitForTimeout(1500)
  await page.reload()
  await page.getByRole('button', { name: 'Ansa', exact: true }).waitFor()
  await page.locator('summary', { hasText: 'Backup & transfer' }).click()
  const second = readFileSync(await exportOnce('backup-2.json'), 'utf8')
  // The import writes pinned: false where the export left it out; same tree.
  // Key order can differ too, so compare each node's sorted entries.
  const norm = (text) =>
    JSON.stringify(
      JSON.parse(text).map((n) => Object.entries(n).filter(([k, v]) => !(k === 'pinned' && v === false)).sort(([a], [b]) => a.localeCompare(b))),
    )
  await expect(norm(second) === norm(firstText), 'an export after importing the first export differs from it')
})

await drive('get-around', async (page, project) => {
  await makeProject(page, project)
  await row(page, 'Parent').hover()
  await page.getByRole('button', { name: 'Zoom into Parent' }).click()
  await page.getByRole('heading', { name: 'Parent', level: 1 }).waitFor()
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' })
  await expect(crumbs.getByRole('button', { name: project }).isVisible(), 'breadcrumb does not name the project')
  await page.reload()
  await page.getByRole('heading', { level: 1 }).waitFor()
  const title = await page.getByRole('heading', { level: 1 }).textContent()
  await expect(title === project, `reload opened "${title}", not the project`)
})

await drive('pin', async (page, project) => {
  await makeProject(page, project)
  await row(page, 'Child A').hover()
  await page.getByRole('button', { name: 'Zoom into Child A' }).click()
  await page.getByRole('button', { name: 'Pin Child A' }).click()
  const side = page.getByRole('complementary')
  await until(async () => (await side.getByText('Child A').count()) > 0, 'Child A not in the sidebar after pinning')
})

await drive('trash', async (page, project) => {
  await makeProject(page, project)
  await row(page, 'Child B').locator('.label-text').click()
  await page.keyboard.press('ControlOrMeta+Backspace')
  await until(async () => (await row(page, 'Child B').count()) === 0, 'Child B still shown after delete')
  await openTrash(page)
  const entry = page.locator('.trash-list li', { hasText: project }).filter({ has: page.locator('.trash-text', { hasText: exactly('Child B') }) })
  await page.screenshot({ path: `${OUT}/trash-open.png` })
  await entry.getByRole('button', { name: 'Restore' }).click()
  await until(async () => (await entry.count()) === 0, 'the entry is still in Trash after Restore')
  await sidebar(page).getByRole('button', { name: project, exact: true }).click()
  await until(async () => (await row(page, 'Child B').count()) === 1, 'Child B not back after restore')
  await expect((await indent(page, 'Child B')) > (await indent(page, 'Parent')), 'Child B restored to the wrong place')
})

await drive('sync', async (page, project) => {
  await makeProject(page, project)
  const other = await newPage()
  try {
    await sidebar(other).getByRole('button', { name: project, exact: true }).click()
    await row(other, 'Child A').waitFor()
    await row(page, 'Child A').locator('.label-text').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' renamed')
    // Enter commits and opens an empty row; Escape drops the empty row.
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await until(async () => (await row(other, 'Child A renamed').count()) === 1, 'the other tab did not show the rename', 8000)
  } finally {
    await other.screenshot({ path: `${OUT}/sync-other.png` })
    await other.close()
  }
})

await drive('mcp', async (page, project) => {
  await makeProject(page, project)
  const id = await row(page, 'Child A').getAttribute('data-id')
  // Launched the way an MCP client launches it.
  const transport = new StdioClientTransport({
    command: `${ROOT}node_modules/.bin/tsx`,
    args: [`${ROOT}mcp/src/index.ts`],
    env: { ...process.env, ANSA_API: API },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'drive', version: '0' })
  await client.connect(transport)
  try {
    const view = await client.callTool({ name: 'view_tree', arguments: {} })
    const viewText = view.content.map((c) => c.text).join('')
    await expect(viewText.includes(id), "view_tree doesn't list the project the browser just made")
    await client.callTool({ name: 'rename_task', arguments: { id, text: 'Child A via MCP' } })
    await until(async () => (await row(page, 'Child A via MCP').count()) === 1, 'the browser did not show the MCP rename', 8000)
  } finally {
    await client.close()
  }
})

await browser.close()
if (!ran) {
  console.error('No drives ran, so nothing was checked. Run `npm run drive` for all of them, or name one.')
  process.exit(1)
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
