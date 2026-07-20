import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Cached version string. */
let _version: string | undefined

/**
 * Reads the package version from `package.json`, falling back to a hard-coded
 * default when the file can't be read (production binary, missing metadata).
 *
 * Looks for `package.json` at two paths relative to this module so it works
 * both from the source tree (development) and the compiled binary (production).
 */
export function readVersion(): string {
  if (_version) return _version

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
