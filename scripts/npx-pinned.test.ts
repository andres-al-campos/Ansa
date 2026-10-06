// @vitest-environment node
/**
 * Law: every tool the repo runs with `npx` is a dependency in package.json.
 *
 * Without that, npx downloads whatever version is latest into a shared cache
 * outside the repo and runs it from there. wrangler ran that way, deploys
 * included: a fresh clone could get a different wrangler than this machine,
 * and nothing in the repo recorded which one shipped.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'))
const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }))

/** A line that is a comment in shell or JS/TS. */
const COMMENT = /^\s*(#|\/\/|\*|\/\*)/

/** `npx [flags] <tool>[@version]` → tool. */
const NPX = /\bnpx\s+(?:-{1,2}[\w-]+\s+)*(@?[\w./-]+?)(?:@[\w.^~-]+)?(?=[\s`'"]|$)/gm

test('every npx tool is pinned in package.json', () => {
  const files = execFileSync('git', ['ls-files', '*.sh', '*.mjs', '*.ts', '*.tsx', '*.md', 'package.json'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f && !f.endsWith('npx-pinned.test.ts'))

  const unpinned: string[] = []
  for (const file of files) {
    const text = readFileSync(`${root}/${file}`, 'utf8')
    for (const m of text.matchAll(NPX)) {
      const line = text.slice(0, m.index).split('\n').length
      // A comment may say npx without running it; Markdown is where commands get copied from.
      if (!file.endsWith('.md') && COMMENT.test(text.split('\n')[line - 1])) continue
      if (!declared.has(m[1])) {
        unpinned.push(`${file}:${line} runs \`npx ${m[1]}\``)
      }
    }
  }

  expect(
    unpinned,
    `These tools aren't in package.json, so npx runs whatever version is in its cache. ` +
      `Fix: npm install -D -E <tool>@<version> (the version you've been running: npx <tool> --version).`,
  ).toEqual([])
})
