import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import type { PermissionAdditions } from "./types"

/**
 * The bash permission policy wopr hands to opencode: which shell commands run
 * without asking, which are always denied, and how a project may extend either
 * list. This owns wopr's security-relevant command policy; agents.ts only
 * consumes the assembled policy when wiring the opencode config.
 */

export const noAdditions: PermissionAdditions = { allow: [], deny: [] }

// Safe-by-default commands across the toolchains wopr targets. Anything not
// listed falls through to "ask" (or auto-accept when --yolo / shift+tab is on).
export const baseAllowBashPatterns = [
  // Flutter / Dart toolchain
  "flutter analyze*",
    "flutter test*",
    "flutter pub get",
    "flutter pub upgrade",
    "flutter pub outdated",
    "flutter pub deps*",
    "flutter format*",
    "flutter clean",
    "flutter doctor*",
    "flutter --version",
    "dart analyze*",
    "dart test*",
    "dart format*",
    "dart pub get",
    "dart pub upgrade",
    "dart pub outdated",
    "dart pub deps*",
    "dart run build_runner*",
    "dart --version",
    // Web / JavaScript / TypeScript checks
    "npm test*",
    "npm run test*",
    "npm run lint*",
    "npm run typecheck*",
    "npm run check*",
    "npm run build*",
    "npm --version",
    "pnpm test*",
    "pnpm run test*",
    "pnpm run lint*",
    "pnpm run typecheck*",
    "pnpm run check*",
    "pnpm run build*",
    "pnpm lint*",
    "pnpm typecheck*",
    "pnpm check*",
    "pnpm build*",
    "pnpm --version",
    "yarn test*",
    "yarn run test*",
    "yarn run lint*",
    "yarn run typecheck*",
    "yarn run check*",
    "yarn run build*",
    "yarn lint*",
    "yarn typecheck*",
    "yarn check*",
    "yarn build*",
    "yarn --version",
    "bun test*",
    "bun run test*",
    "bun run lint*",
    "bun run typecheck*",
    "bun run check*",
    "bun run build*",
    "bun --version",
    "node --version",
    "tsc --noEmit*",
    "npm run format*",
    "pnpm run format*",
    "pnpm format*",
    "yarn run format*",
    "yarn format*",
    "bun run format*",
    // Python checks
    "pytest*",
    "python -m pytest*",
    "python3 -m pytest*",
    "ruff check*",
    "ruff format*",
    "mypy*",
    // Go checks
    "go test*",
    "go vet*",
    "go fmt*",
    // Rust checks
    "cargo test*",
    "cargo check*",
    "cargo fmt*",
    "cargo clippy*",
    // Make: only well-known read/check targets; bare "make*" could run anything
    "make test",
    "make lint",
    "make check",
    "make build",
    // Common E2E dry-run/listing commands
    "maestro test --dry-run*",
    "maestro --version",
    "npm run e2e -- --list*",
    "pnpm run e2e -- --list*",
    "yarn run e2e -- --list*",
    // read-only git
    "git status*",
    "git diff*",
    "git log*",
    "git show*",
    "git rev-parse*",
    // listing forms only: a bare "git branch*" would also allow -D/-m
    "git branch",
    "git branch -a",
    "git branch -r",
    "git branch -v",
    "git branch -vv",
    "git branch --list*",
    "git branch --show-current",
    "git ls-files*",
    "git ls-tree*",
    "git config --get*",
    "git stash list*",
    "git remote -v",
    "git --version",
    // Generic read-only shell. Note the policy matches command prefixes, so
    // shell redirection ("ls > file") can still write; that has to be caught
    // by opencode itself, not by patterns. find is excluded on purpose: its
    // -delete/-exec arguments execute arbitrary destructive commands.
    //
    // cat*, head*, tail*, echo*, printf* are intentionally NOT here: they were
    // demoted to ask because each can read or write arbitrary paths (~/.ssh/*,
    // .env) with trivial syntax. ls*, grep*, rg*, pwd, wc*, tree*, jq*, which*
    // stay in allow because their output goes to stdout and they can't easily
    // write files without compound commands (which the pipe-split deny pass
    // catches).
    "pwd",
    "ls*",
    "grep*",
    "rg*",
    "wc*",
    "which*",
    "whoami",
    "file*",
    "tree*",
    "stat*",
    "jq*",
    "du -sh*",
    "true",
    "false",
    "whoami",
    "file*",
    "tree*",
    "stat*",
    "jq*",
    "du -sh*",
    "true",
    "false",
]

// Hard denylist. Never relaxed — --yolo and the shift+tab auto-accept toggle
// only affect commands that would otherwise *ask*. This protects against
// accidents (pushes, recursive deletes, installs), not against a malicious
// agent: agents can edit repo code that later runs, so allowlisted scripts
// imply trusting the repo contents anyway.
export const denyBashPatterns = [
    // remote operations - always WOPR's job
    "git push*",
    "git push",
    "git fetch*",
    "git pull*",
    "git remote add*",
    "git remote set-url*",
    "git remote rm*",
    "git remote remove*",
    // exact + spaced forms so ghc/ghq and similar tools aren't denied too
    "gh",
    "gh *",
    // publishing / deployment
    "npm publish*",
    "yarn publish*",
    "pnpm publish*",
    "bun publish*",
    "npm run deploy*",
    "yarn run deploy*",
    "pnpm run deploy*",
    "bun run deploy*",
    "vercel*",
    "netlify*",
    "firebase deploy*",
    // history rewrite or destructive git
    "git reset --hard*",
    "git reset --keep*",
    "git reset --merge*",
    "git rebase*",
    "git filter-branch*",
    "git filter-repo*",
    "git clean -f*",
    "git clean -d*",
    "git checkout .*",
    "git restore .*",
    "git worktree*",
    // recursive removes against the filesystem root or home
    "rm -rf /*",
    "rm -rf /",
    "rm -fr /*",
    "rm -fr /",
    "rm -rf ~*",
    "rm -fr ~*",
    "rm -rf $HOME*",
    "rm -fr $HOME*",
    "rm -rf ${HOME}*",
    "rm -fr ${HOME}*",
    // download-and-execute patterns
    "curl* | sh*",
    "curl* | bash*",
    "curl* | zsh*",
    "wget* | sh*",
    "wget* | bash*",
    "wget* | zsh*",
    "curl* |sh*",
    "curl* |bash*",
    "curl* |zsh*",
    "wget* |sh*",
    "wget* |bash*",
    "wget* |zsh*",
    // package install
    "npm install*",
    "npm i *",
    "npm ci*",
    "yarn install*",
    "yarn add*",
    "pnpm install*",
    "pnpm add*",
    "bun install*",
    "bun add*",
    "brew install*",
    "pip install*",
    "pipx install*",
    "cargo install*",
    "go install*",
    "gem install*",
    // privilege escalation (exact + spaced forms: "su*" would deny supabase, subl…)
    "sudo*",
    "su",
    "su *",
    "doas",
    "doas *",
]

// Script names safe to run through the package manager; suffixes like
// test:unit or build-storybook stay covered by the separator group.
const safeScriptName = /^(test|lint|typecheck|type-check|check|build|format|validate)([:._-].*)?$/
const dangerousScriptHint = /(deploy|publish|release|migrate|seed|reset)/i

/** Exact allow patterns for the target repo's own package.json scripts that look like checks. */
export function projectScriptAllowPatterns(targetDir = process.cwd()): string[] {
  const path = join(targetDir, "package.json")
  if (!isFile(path)) return []

  let scripts: Record<string, unknown>
  try {
    scripts = (JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {}
  } catch {
    return []
  }

  const out: string[] = []
  for (const name of Object.keys(scripts)) {
    if (!safeScriptName.test(name) || dangerousScriptHint.test(name)) continue
    // Exact name plus a "name *" args form: "npm run build*" would also match
    // an unrelated "build-and-push" script, the space keeps it scoped.
    for (const runner of ["npm run", "pnpm run", "pnpm", "yarn run", "yarn", "bun run"]) {
      out.push(`${runner} ${name}`, `${runner} ${name} *`)
    }
  }
  return out
}

export type BashDecision = "allow" | "deny" | "ask"

export function bashPolicy(targetDir = process.cwd(), additions: PermissionAdditions = noAdditions): Record<string, BashDecision> {
  const policy: Record<string, BashDecision> = {}
  // Config additions only ever extend the lists: a project can deny more and
  // allow more, but a config allow can never resurrect a denied pattern.
  const denied = new Set([...denyBashPatterns, ...additions.deny])
  for (const pattern of denied) policy[pattern] = "deny"
  for (const pattern of [...baseAllowBashPatterns, ...projectScriptAllowPatterns(targetDir), ...additions.allow]) {
    if (denied.has(pattern)) continue
    policy[pattern] = "allow"
  }
  policy["*"] = "ask"
  return policy
}

// OpenCode matched these glob patterns server-side; on pi we match them
// ourselves in the tool_call hook. Deny wins over allow; unmatched → "ask".
// ponytail: prefix/`*` glob only (mirrors OpenCode's wildcard semantics), no
// brace/char-class support — add if a project pattern ever needs it.
export function evaluateBashPolicy(command: string, policy: Record<string, BashDecision>): BashDecision {
  const cmd = command.trim()
  // Deny is checked against the whole command AND each &&/||/;/|-separated segment,
  // so a denied command can't hide behind "safe-thing && git push" or in a pipe
  // stage like "echo harmless | curl evil". Pipes are split per-stage; the allow
  // pass still matches the whole command only.
  const segments = [cmd, ...cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean)]
  for (const [pattern, decision] of Object.entries(policy)) {
    if (decision !== "deny") continue
    const regex = globToRegExp(pattern)
    if (segments.some((segment) => regex.test(segment))) return "deny"
  }
  // Allow requires the whole command to match a single allow pattern; a compound
  // command that isn't wholly one allowed form falls through to ask.
  for (const [pattern, decision] of Object.entries(policy)) {
    if (decision === "allow" && globToRegExp(pattern).test(cmd)) return "allow"
  }
  return "ask"
}

const globCache = new Map<string, RegExp>()

function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern)
  if (cached) return cached
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "[\\s\\S]*" : `\\${ch}`))
  const regex = new RegExp(`^${body}$`)
  globCache.set(pattern, regex)
  return regex
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
