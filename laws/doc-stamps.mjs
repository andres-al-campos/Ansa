// Law: each feature file, the README and any guide in docs/ carries a stamp, "Updated
// YYYY-MM-DD HH:MM, at <version>.", and each Principle and Call starts "YYYY-MM-DD HH:MM,
// <version>.", with a time that isn't in the future and a version Ansa has had. A Call's
// "Applies *Name*." names a Principle in AGENTS.md. The pre-commit hook (.githooks/stamp-docs.mjs)
// writes the stamps; this catches a commit made with the hook off.
//
// Usage: node laws/doc-stamps.mjs [repo-root]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const STAMP = /^Updated (.+), at (\S+)\.$/m;
const md = (dir) => fs.existsSync(path.join(root, dir))
  ? fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.md')).map((f) => `${dir}/${f}`)
  : [];
const features = md('features');
const docs = [...features, 'README.md', ...md('docs')];

// Every version package.json has had, so a typo'd version doesn't pass for a real one.
const known = new Set([current]);
try {
  const log = execFileSync('git', ['log', '-p', '--format=', '--', 'package.json'], { cwd: root, encoding: 'utf8' });
  for (const m of log.matchAll(/^[-+ ]\s*"version": "([^"]+)"/gm)) known.add(m[1]);
} catch {} // not a git checkout: only the current version is known

const now = new Date();
const stampNow = () => {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
};
// Problems with a time and version, or none.
const check = (time, version) => {
  const m = time.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/);
  const when = m && new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
  // Date rolls 25:00 over to the next day; a real time reads back the same.
  if (!when || when.getMonth() !== m[2] - 1 || when.getDate() !== +m[3] || when.getHours() !== +m[4]) return `"${time}" isn't a time like ${stampNow()}`;
  if (when > now) return `${time} is in the future`;
  if (!known.has(version)) return `${version} is a version package.json has never had (now ${current})`;
};

const failures = [];
let stamped = 0;
for (const doc of docs) {
  const stamp = fs.readFileSync(path.join(root, doc), 'utf8').match(STAMP);
  if (!stamp) {
    failures.push(`${doc} has no stamp. Turn the hook on (./build.sh does it) and it adds one the next time the file is committed, ` +
      `or add under its title: "Updated ${stampNow()}, at ${current}."`);
    continue;
  }
  stamped++;
  const problem = check(stamp[1], stamp[2]);
  if (problem) failures.push(`${doc}'s stamp: ${problem}. Set it to when the description last changed, like "Updated ${stampNow()}, at ${current}."`);
}

// Principle names, from "**Name.**" after each Principle's time.
const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
const principles = new Set([...(agents.split(/^## /m).find((s) => s.startsWith('Principles')) ?? '').matchAll(/^- [^*\n]*\*\*(.+?)\.\*\*/gm)].map((m) => m[1]));

let entries = 0;
for (const file of ['AGENTS.md', ...features]) {
  let inSection = false;
  fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, i) => {
    if (/^#{1,6} /.test(line)) inSection = /^## (Principles|Calls)\b/.test(line);
    if (!inSection) return;
    for (const [, name] of line.matchAll(/Applies \*(.+?)\*\./g)) {
      if (!principles.has(name)) failures.push(`${file}:${i + 1}: cites "${name}", which isn't a Principle in AGENTS.md (${[...principles].join('; ') || 'none named yet'}). Cite one of those, or none.`);
    }
    if (!line.startsWith('- ')) return;
    entries++;
    const prefix = line.match(/^- (\d{4}-\d\d-\d\d \d\d:\d\d), (\S+?)\. /);
    const problem = prefix ? check(prefix[1], prefix[2])
      : `starts "${line.slice(2, 22)}…" without a time and version`;
    if (problem) failures.push(`${file}:${i + 1}: ${problem}. Start it with when the call was made and Ansa's version then, like "- ${stampNow()}, ${current}. ".`);
  });
}

if (failures.length) {
  for (const f of failures) console.error(`✗ doc-stamps: ${f}`);
  process.exit(1);
}
console.log(`✓ doc-stamps: ${stamped} docs stamped, ${entries} Principles and Calls dated, each with a time and version Ansa has had; every cited Principle exists`);
