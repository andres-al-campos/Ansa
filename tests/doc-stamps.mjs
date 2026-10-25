// Law: every doc, Principle and Call is stamped with a real time and a version package.json has had,
// and every "Applies *Name*." names a Principle in AGENTS.md. The pre-commit hook writes the
// stamps; this catches a commit made with the hook off. The check itself is the hook's
// --check, so it can't drift from what the hook writes.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('../dev/hooks/stamp-docs.mjs', import.meta.url));
process.exit(spawnSync(process.execPath, [hook, '--check', 'package.json'], { stdio: 'inherit' }).status ?? 1);
