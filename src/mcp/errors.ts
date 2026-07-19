import { ConfigError, RunNotFoundError, ValidationError, AbortError, BudgetExceededError } from "../core/errors"

/**
 * Serialize a WOPR error to an MCP error response.
 * Returns JSON-compatible error info with numerical codes.
 */
export function serializeError(e: unknown): { code: number; message: string; data?: unknown } {
  if (e instanceof ConfigError) {
    return { code: -32001, message: "config_error", data: { message: e.message } }
  }
  if (e instanceof RunNotFoundError) {
    return { code: -32002, message: "run_not_found", data: { runId: e.runId } }
  }
  if (e instanceof ValidationError) {
    return { code: -32003, message: "validation_error", data: { errors: e.errors } }
  }
  if (e instanceof AbortError) {
    return { code: -32004, message: "aborted", data: { reason: e.reason } }
  }
  if (e instanceof BudgetExceededError) {
    return { code: -32005, message: "budget_exceeded", data: { phase: e.phase, spent: e.spent, budget: e.budget } }
  }
  // Unknown error: don't leak internals
  return {
    code: -32603,
    message: "internal_error",
    data: { message: e instanceof Error ? e.message : String(e) },
  }
}
