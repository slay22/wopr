import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// Isolate every test run from the developer's real ~/.wopr so tests never
// read or write the user's actual config, runs, or agent prompts. WOPR_HOME
// points at the directory that holds `.wopr` (the same convention as a repo
// root), so the global config resolves to <tmp>/.wopr/config.yaml.
process.env.WOPR_HOME ??= join(tmpdir(), `wopr-test-home-${process.pid}`)
mkdirSync(process.env.WOPR_HOME, { recursive: true })

// Point the model catalog loader at a small fixture so tests don't depend
// on ~/.pi/agent/models-store.json (a file pi writes after running). Setting
// this here in the preload means it's in place before any test file imports
// src/cost.ts (the catalog is cached at first call).
const here = dirname(fileURLToPath(import.meta.url))
process.env.WOPR_MODEL_CATALOG_PATH = join(here, "fixtures", "models-store.json")
