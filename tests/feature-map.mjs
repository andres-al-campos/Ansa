// Law: the feature map matches its files, its drives and its UI tests.
//
// The map is what "done" is checked against, so it can't drift from the code:
// every row in dev/features/README.md has a file, every file has a row, and every
// file's "Driving it" names checks that exist. A web check is
// `npm run drive -- <scenario>`, and scripts/drive.mjs must have a
// drive('<scenario>', …). An iOS check is `ios/build.sh drive <name>`, and
// ios/UITests/<Name>Tests.swift must exist. A feature with neither writes
// "No check yet" and why.
//
// Scenarios are read from drive.mjs as source text: importing it would run
// every drive. Can't catch a check that exists but checks the wrong thing;
// breaking the feature once and watching it fail covers that.
//
//   node tests/feature-map.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(`${root}${path}`, 'utf8')

const readme = read('dev/features/README.md')
const rows = [...readme.matchAll(/^\|[^|]+\| \[[^\]]+\]\(([^)]+\.md)\)/gm)].map((m) => m[1])
const files = readdirSync(`${root}dev/features`).filter((f) => f.endsWith('.md') && f !== 'README.md')
const scenarios = [...read('scripts/drive.mjs').matchAll(/^await drive\('([^']+)'/gm)].map((m) => m[1])
const uiTests = readdirSync(`${root}ios/UITests`).filter((f) => f.endsWith('Tests.swift'))
// check-off → CheckOffTests, the same mapping ios/build.sh drive makes.
const testClass = (name) => name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('') + 'Tests'

const problems = []
for (const r of rows.filter((r) => !files.includes(r))) {
  problems.push(`dev/features/README.md links ${r}, which doesn't exist. Fix the link or remove the row.`)
}
for (const f of files.filter((f) => !rows.includes(f))) {
  problems.push(`dev/features/${f} has no row in dev/features/README.md. Add a row to the table.`)
}
for (const f of files) {
  const driving = /^## Driving it\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(read(`dev/features/${f}`))?.[1]
  if (driving === undefined) {
    problems.push(`dev/features/${f} has no "## Driving it" section. Add one naming its checks, or "No check yet" and why.`)
    continue
  }
  if (/No check yet/.test(driving)) continue
  const web = [...driving.matchAll(/`npm run drive -- ([\w-]+)[^`]*`/g)].map((m) => m[1])
  const ios = [...driving.matchAll(/`ios\/build\.sh drive ([\w-]+)`/g)].map((m) => m[1])
  // Each bullet is one check, so each leads with its command.
  for (const b of driving.split('\n').filter((l) => l.startsWith('- '))) {
    if (!/^- `(npm run drive -- |ios\/build\.sh drive )/.test(b)) {
      problems.push(`dev/features/${f} has a check that doesn't lead with its command: "${b}". ` +
        'Start the bullet with `npm run drive -- <scenario>` or `ios/build.sh drive <name>`.')
    }
  }
  if (!web.length && !ios.length) {
    problems.push(`dev/features/${f} names no check. Lead a bullet in "Driving it" with ` +
      '`npm run drive -- <scenario>` or `ios/build.sh drive <name>`, or write "No check yet" and why.')
  }
  for (const s of web.filter((s) => !scenarios.includes(s))) {
    problems.push(`dev/features/${f} runs \`npm run drive -- ${s}\`, but scripts/drive.mjs has no drive('${s}', …). ` +
      `Fix the name or write the drive (it has: ${scenarios.join(', ')}).`)
  }
  for (const n of ios.filter((n) => !existsSync(`${root}ios/UITests/${testClass(n)}.swift`))) {
    problems.push(`dev/features/${f} runs \`ios/build.sh drive ${n}\`, but there's no ios/UITests/${testClass(n)}.swift. ` +
      `Fix the name or write the test (there are: ${uiTests.join(', ')}).`)
  }
}

if (!problems.length) {
  console.log('  ok    feature-map')
  process.exit(0)
}
console.log('  FAIL  feature-map: the feature map has drifted from its files or checks:')
for (const p of problems) console.log(`          ${p}`)
process.exit(1)
