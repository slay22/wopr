import { log } from "./log"

// `wopr runs` used to attach to a live run's OpenCode server and mirror its
// event stream into a read-only dashboard. pi runs in-process with no server to
// attach to, so live-mirroring is dropped for the MVP port.
// ponytail: rebuild on pi's JSONL session files (SessionManager can tail them)
// if watching a run from another terminal becomes a real need.
export async function openRunDashboard(runID: string): Promise<void> {
  log.warn(`attaching to a live run's dashboard isn't supported on the pi port (run ${runID}). Watch the run in its own terminal instead.`)
}
