import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate every test run from the developer's real ~/.wopr so tests never
// read or write the user's actual config, runs, or agent prompts. WOPR_HOME
// points at the directory that holds `.wopr` (the same convention as a repo
// root), so the global config resolves to <tmp>/.wopr/config.yaml.
process.env.WOPR_HOME ??= join(tmpdir(), `wopr-test-home-${process.pid}`)
mkdirSync(process.env.WOPR_HOME, { recursive: true })
