/**
 * Test helper: reset the cached model catalog.
 *
 * The catalog is pre-populated by the test preload (test/env.ts), which sets
 * WOPR_MODEL_CATALOG_PATH to a small fixture before any test file imports
 * src/cost.ts. After the first import, the catalog is cached. This helper
 * drops the cache so a subsequent call to loadModelCatalog() re-reads from
 * the (fixture) path.
 *
 * Most tests don't need this. The only reason to call resetModelCatalog() is
 * when a test wants to mutate the fixture catalog on disk and see the change
 * reflected in the next loadModelCatalog() call.
 */
import { resetModelCatalog } from "../../src/cost"

export { resetModelCatalog }
