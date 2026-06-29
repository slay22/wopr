#!/usr/bin/env bun
import { parseAndRun } from "./cli"
import { log } from "./log"
import { isIgnorableRejection, isUserAbortError } from "./runner"

// The opencode SDK's SSE client cancels its reader on abort without awaiting it;
// on Bun that surfaces as an unhandled rejection that would otherwise kill the
// run. Swallow only that known-benign abort — every other unhandled rejection is
// a real fault, so log it loudly (with its stack) instead of hiding it. We don't
// rethrow: a long-running TUI session shouldn't die from one stray rejection.
process.on("unhandledRejection", (reason) => {
  if (isIgnorableRejection(reason)) {
    log.warn(`ignored async abort: ${reason instanceof Error ? reason.message : String(reason)}`)
    return
  }
  log.error(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
})

parseAndRun(Bun.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(isUserAbortError(error) ? 130 : 1)
})
