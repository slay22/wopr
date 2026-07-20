/**
 * Test helper: install a hermetic model catalog in a temp HOME for the
 * duration of the test file. wopr's `loadModelCatalog` reads from
 * `~/.pi/agent/models-store.json` (a file pi writes after running).
 * In CI there's no pi history, so the catalog is empty and tests that
 * depend on it (suggestConfigForBudget, previewRun, etc.) fail.
 *
 * Usage (top of any test file that needs the catalog):
 *   import { setupCatalogFixture } from "./_helpers/catalog-fixture"
 *   setupCatalogFixture()
 */
import { afterAll, beforeAll } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { resetModelCatalog } from "../../src/cost"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const fixturePath = join(__dirname, "..", "fixtures", "models-store.json")

export function setupCatalogFixture() {
  let originalHome: string | undefined
  let tempHome: string

  beforeAll(() => {
    originalHome = process.env.HOME
    tempHome = mkdtempSync(join(tmpdir(), "wopr-test-"))
    process.env.HOME = tempHome
    mkdirSync(join(tempHome, ".pi", "agent"), { recursive: true })

    // Copy the fixture into the temp HOME so loadModelCatalog finds it.
    const content = readFileSync(fixturePath, "utf8")
    writeFileSync(join(tempHome, ".pi", "agent", "models-store.json"), content)

    // Drop any cached catalog from earlier tests.
    resetModelCatalog()
  })

  afterAll(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome
    if (tempHome) rmSync(tempHome, { recursive: true, force: true })
  })
}
