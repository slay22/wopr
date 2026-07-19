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

  toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message, runId: this.runId }
  }
}

export class ValidationError extends Error {
  readonly errors: string[]
  constructor(errors: string[]) {
    super(`validation failed: ${errors.join("; ")}`)
    this.name = "ValidationError"
    this.errors = errors
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message, errors: this.errors }
  }
}

export class AbortError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`aborted: ${reason}`)
    this.name = "AbortError"
    this.reason = reason
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message, reason: this.reason }
  }
}
