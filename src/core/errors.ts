import { ConfigError } from "../config"

export { ConfigError }

export { BudgetExceededError } from "../runner"

export class RunNotFoundError extends Error {
  readonly runId: string
  constructor(runId: string) {
    super(`run not found: ${runId}`)
    this.name = "RunNotFoundError"
    this.runId = runId
  }
}

export class ValidationError extends Error {
  readonly errors: string[]
  constructor(errors: string[]) {
    super(`validation failed: ${errors.join("; ")}`)
    this.name = "ValidationError"
    this.errors = errors
  }
}

export class AbortError extends Error {
  constructor(reason: string) {
    super(`aborted: ${reason}`)
    this.name = "AbortError"
  }
}
