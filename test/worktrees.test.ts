import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { addWorktree } from "../src/git"
import { listWorktrees, pruneWorktrees, worktreesRoot } from "../src/worktrees"

describe("worktrees list/prune", () => {
  const dirs: string[] = []
  let prevHome: string | undefined

  beforeAll(async () => {
    prevHome = process.env.WOPR_HOME
    const home = await realpath(await mkdtemp(join(tmpdir(), "wopr-wt-home-")))
    dirs.push(home)
    process.env.WOPR_HOME = home
  })

  afterAll(async () => {
    if (prevHome === undefined) delete process.env.WOPR_HOME
    else process.env.WOPR_HOME = prevHome
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    })
    const stdout = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
    return stdout.trim()
  }

  async function repo(): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "wopr-wt-repo-")))
    dirs.push(dir)
    await git(["init", "-q", "-b", "main"], dir)
    await git(["commit", "-q", "--allow-empty", "-m", "init"], dir)
    return dir
  }

  test("lists a worktree, then prunes its checkout while keeping the branch", async () => {
    const r = await repo()
    await mkdir(worktreesRoot(), { recursive: true })
    const wtDir = join(worktreesRoot(), "add-feature")
    await addWorktree(wtDir, "add-feature", "HEAD", r)

    const list = await listWorktrees()
    expect(list).toHaveLength(1)
    expect(list[0]!.branch).toBe("add-feature")
    expect(list[0]!.stale).toBe(false)
    expect(list[0]!.mainRepo).toBe(r)

    const { removed, skipped } = await pruneWorktrees()
    expect(removed).toEqual([wtDir])
    expect(skipped).toHaveLength(0)

    // The checkout is gone...
    await expect(access(wtDir)).rejects.toThrow()
    // ...but the branch (and its commits) survive in the main repo.
    expect(await git(["branch", "--list", "add-feature"], r)).toContain("add-feature")
    expect(await listWorktrees()).toHaveLength(0)
  })
})
