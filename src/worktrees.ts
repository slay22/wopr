import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"

import { removeWorktree, worktreeInfo } from "./git"
import { woprHome } from "./workspace"

/** Directory holding the isolated worktrees `--worktree` / the TUI toggle create. */
export function worktreesRoot() {
  return join(woprHome(), "worktrees")
}

export type WorktreeListing = { dir: string; branch: string | null; mainRepo: string | null; stale: boolean }

export async function listWorktrees(): Promise<WorktreeListing[]> {
  let names: string[]
  try {
    names = await readdir(worktreesRoot())
  } catch {
    return [] // no worktrees dir yet
  }
  const out: WorktreeListing[] = []
  for (const name of names.sort()) {
    const dir = join(worktreesRoot(), name)
    const info = await worktreeInfo(dir)
    out.push(info ? { dir, branch: info.branch, mainRepo: info.mainRepo, stale: false } : { dir, branch: null, mainRepo: null, stale: true })
  }
  return out
}

export type PruneResult = { removed: string[]; skipped: { dir: string; reason: string }[] }

/**
 * Removes worktree checkouts under `~/.wopr/worktrees`, keeping their branches.
 * Stale entries (main repo gone) are just deleted. Live worktrees with
 * uncommitted changes are skipped unless `force` is set — git enforces this.
 */
export async function pruneWorktrees(opts: { force?: boolean } = {}): Promise<PruneResult> {
  const result: PruneResult = { removed: [], skipped: [] }
  for (const wt of await listWorktrees()) {
    if (wt.stale || !wt.mainRepo) {
      await rm(wt.dir, { recursive: true, force: true })
      result.removed.push(wt.dir)
      continue
    }
    try {
      await removeWorktree(wt.mainRepo, wt.dir, opts.force)
      result.removed.push(wt.dir)
    } catch (error) {
      result.skipped.push({ dir: wt.dir, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
