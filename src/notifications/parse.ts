import type { NotificationTarget, NtfyTarget } from "./types"

/**
 * Redacts any userinfo (`user:pass@`) before echoing a URL in an error
 * message, so credentials are never leaked through logs or CLI output
 * (which re-wrap this message in `ConfigError` / CLI errors).
 */
function maskCredentialsForError(raw: string): string {
  // scheme://userinfo@host/path → scheme://***@host/path
  return raw.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+@)/, "$1***@")
}

/**
 * Parses a URL of the form:
 *   ntfy://<topic>                              → ntfy.sh, no auth
 *   ntfy://<server>/<topic>                    → self-hosted, no auth
 *   ntfy://<user>:<pass>@<server>/<topic>      → self-hosted with auth
 *
 * Throws Error for malformed URLs.
 */
export function parseNotificationUrl(raw: string): NotificationTarget {
  if (!raw.startsWith("ntfy://")) {
    throw new Error(`notification URL must start with "ntfy://", got: ${maskCredentialsForError(raw)}`)
  }

  const withoutScheme = raw.slice("ntfy://".length)

  // Split user:pass@host from the rest
  let user: string | undefined
  let pass: string | undefined
  let hostPortPath: string

  const atIndex = withoutScheme.lastIndexOf("@")
  if (atIndex >= 0) {
    const credentials = withoutScheme.slice(0, atIndex)
    hostPortPath = withoutScheme.slice(atIndex + 1)
    const colonIndex = credentials.indexOf(":")
    if (colonIndex >= 0) {
      user = credentials.slice(0, colonIndex)
      pass = credentials.slice(colonIndex + 1)
    } else {
      user = credentials
    }
  } else {
    hostPortPath = withoutScheme
  }

  // Split host:port from topic path
  const firstSlash = hostPortPath.indexOf("/")
  if (firstSlash < 0) {
    // ntfy://<topic> — single segment, use ntfy.sh as server
    const topic = hostPortPath
    if (!topic) throw new Error("notification URL must include a topic, got empty topic")
    return {
      kind: "ntfy",
      server: "https://ntfy.sh",
      topic,
      ...(user !== undefined && pass !== undefined ? { auth: { user, pass } } : {}),
    }
  }

  const host = hostPortPath.slice(0, firstSlash)
  const topic = hostPortPath.slice(firstSlash + 1)
  if (!host) throw new Error("notification URL must include a server hostname")
  if (!topic) throw new Error("notification URL must include a topic")

  const server = host.includes("://") ? host : `https://${host}`
  return {
    kind: "ntfy",
    server,
    topic,
    ...(user !== undefined && pass !== undefined ? { auth: { user, pass } } : {}),
  }
}
