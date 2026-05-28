import { chmod, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)))
const entrypoint = join(repoDir, "src", "main.ts")
const output = join(repoDir, "archer")

const launcher = `#!/usr/bin/env bash
set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
  echo "archer: Bun is required to run this launcher" >&2
  exit 127
fi

exec bun ${shellQuote(entrypoint)} "$@"
`

await writeFile(output, launcher, { mode: 0o755 })
await chmod(output, 0o755)

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
