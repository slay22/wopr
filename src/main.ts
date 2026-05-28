#!/usr/bin/env bun
import { parseAndRun } from "./cli"
import { isUserAbortError } from "./runner"

parseAndRun(Bun.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(isUserAbortError(error) ? 130 : 1)
})
