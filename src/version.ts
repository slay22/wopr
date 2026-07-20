/**
 * WOPR_VERSION is injected at build time by `bun build --define`. The compiled
 * binary has no package.json bundled, so we can't read the version at runtime;
 * the build wires the value in.
 *
 * For dev (running from source), the undeclared constant is undefined and we
 * fall through to reading package.json.
 */
declare const WOPR_VERSION: string | undefined

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Cached version string. */
let _version: string | undefined

/**
 * Reads the package version from `package.json`, falling back to the build-time
 * --define value, then to a hard-coded default. The first two paths are
 * exercised in dev (source tree) and in the compiled binary respectively.
 */
export function readVersion(): string {
  if (_version) return _version

  // Build-time injection (preferred for compiled binaries).
  if (typeof WOPR_VERSION === "string" && WOPR_VERSION.length > 0) {
    _version = WOPR_VERSION
    return _version
  }

  // Dev fallback: read package.json from the source tree.
  const paths = [
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
  ]
  for (const p of paths) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string }
      if (pkg.version) {
        _version = pkg.version
        return _version
      }
    } catch {
      // try next path
    }
  }

  _version = "0.1.0"
  return _version
}
