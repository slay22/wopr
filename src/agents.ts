import { readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { AgentConfig, Config } from "@opencode-ai/sdk/v2"
import type { AgentName } from "./phases"

const sourceDir = dirname(fileURLToPath(import.meta.url))
const builtInPromptsDir = join(sourceDir, "..", "prompts")
const runtimeSafetyPrompt = "runtime-safety"

export function opencodeConfig(runDir: string, targetDir = process.cwd()): Config {
  const agent = {
    implementer: agentConfig(
      "Implements the feature described in the PRD respecting repo patterns",
      undefined,
      loadAgentPrompt("implementer", targetDir),
      runDir,
      false,
    ),
    "pattern-auditor": agentConfig(
      "Audits patterns and best practices, applies refactoring without changing behavior",
      undefined,
      loadAgentPrompt("pattern-auditor", targetDir),
      runDir,
      false,
    ),
    "security-auditor": agentConfig(
      "Audits the new implementation for security issues and fixes them",
      undefined,
      loadAgentPrompt("security-auditor", targetDir),
      runDir,
      false,
    ),
    "design-polisher": agentConfig(
      "Polishes new UI following the repo's design system, without redesigning",
      0.2,
      loadAgentPrompt("design-polisher", targetDir),
      runDir,
      false,
    ),
    "test-engineer": agentConfig(
      "Ensures automated tests and relevant E2E coverage",
      undefined,
      loadAgentPrompt("test-engineer", targetDir),
      runDir,
      false,
    ),
    "adversarial-reviewer": agentConfig(
      "Final adversarial reviewer before PR creation",
      0.1,
      loadAgentPrompt("adversarial-reviewer", targetDir),
      runDir,
      false,
    ),
  } satisfies Record<AgentName, AgentConfig>

  return {
    agent,
    provider: providerTimeouts(),
    permission: {
      question: "deny",
    },
  }
}

export function loadAgentPrompt(agentName: AgentName, targetDir = process.cwd()) {
  const agentPrompt = readProjectAgentPrompt(agentName, targetDir) ?? readBuiltInPrompt(agentName)
  const safetyPrompt = readBuiltInPrompt(runtimeSafetyPrompt)
  return [agentPrompt.trimEnd(), "", "---", "", safetyPrompt.trim()].join("\n")
}

export function projectAgentPromptPath(agentName: AgentName, targetDir: string) {
  return join(targetDir, ".archer", "agents", `${agentName}.md`)
}

export function builtInPromptPath(promptName: AgentName | typeof runtimeSafetyPrompt) {
  return join(builtInPromptsDir, `${promptName}.md`)
}

function readProjectAgentPrompt(agentName: AgentName, targetDir: string) {
  const path = projectAgentPromptPath(agentName, targetDir)
  if (!isFile(path)) return undefined
  return readFileSync(path, "utf8")
}

function readBuiltInPrompt(promptName: AgentName | typeof runtimeSafetyPrompt) {
  const path = builtInPromptPath(promptName)
  if (!isFile(path)) throw new Error(`missing built-in prompt: ${path}`)
  return readFileSync(path, "utf8")
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const providerIdleTimeoutMs = 10 * 60 * 1000

function providerTimeouts(): Config["provider"] {
  const options = {
    timeout: false as const,
    chunkTimeout: providerIdleTimeoutMs,
  }

  return {
    anthropic: { options },
    openai: { options },
    openrouter: { options },
  }
}

function agentConfig(
  description: string,
  temperature: number | undefined,
  prompt: string,
  runDir: string,
  webfetch: boolean,
): AgentConfig {
  return {
    description,
    mode: "primary",
    ...(temperature === undefined ? {} : { temperature }),
    tools: {
      read: true,
      write: true,
      edit: true,
      bash: true,
      webfetch,
    },
    permission: {
      edit: "allow",
      question: "deny",
      bash: bashPolicy(),
      external_directory: {
        "*": "deny",
        [join(runDir, "**")]: "allow",
      },
    },
    prompt,
  }
}

export function bashPolicy(): Record<string, "allow" | "deny" | "ask"> {
  const allow = [
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
    "git branch*",
    "git ls-files*",
    "git ls-tree*",
    "git config --get*",
    "git stash list*",
    "git remote -v",
    "git --version",
    // generic read-only shell
    "pwd",
    "ls*",
    "cat*",
    "head*",
    "tail*",
    "grep*",
    "rg*",
    "find*",
    "wc*",
    "echo*",
    "printf*",
    "which*",
    "whoami",
    "file*",
    "tree*",
    "stat*",
    "true",
    "false",
  ]
  const deny = [
    // remote operations - always Archer's job
    "git push*",
    "git push",
    "git fetch*",
    "git pull*",
    "git remote add*",
    "git remote set-url*",
    "git remote rm*",
    "git remote remove*",
    "gh*",
    "gh ",
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
    // download-and-execute patterns
    "curl* | sh*",
    "curl* | bash*",
    "wget* | sh*",
    "wget* | bash*",
    "curl* |sh*",
    "curl* |bash*",
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
    // privilege escalation
    "sudo*",
    "su*",
    "doas*",
  ]
  const policy: Record<string, "allow" | "deny" | "ask"> = {}
  for (const pattern of deny) policy[pattern] = "deny"
  for (const pattern of allow) policy[pattern] = "allow"
  policy["*"] = "ask"
  return policy
}
