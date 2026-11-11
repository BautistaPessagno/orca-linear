// The error every backend throws, with a `kind` the panel can act on and a sentence it can show.
//
//   no-cli           the Orca CLI was not found
//   not-connected    Orca has no Linear connection, or no API key for this workspace
//   unauthenticated  the API key was refused
//   unsupported      this backend cannot do it (the current cycle on the CLI backend)
//   invalid          the input was refused before anything was sent
//   not-found        no such issue
//   rate-limited     Linear asked to slow down (retryAfterMs)
//   error            anything else
export class LinearError extends Error {
  constructor(kind, message, extra) {
    super(message)
    this.kind = kind
    this.code = kind
    if (extra) Object.assign(this, extra)
  }
}

export const MESSAGES = Object.freeze({
  noCli: 'Could not find the Orca CLI. Set the Orca CLI path in this plugin’s settings.',
  notConnected: 'Orca has no Linear connection. Connect Linear in Orca’s settings, or add a Linear API key in this panel.',
  cycleNeedsKey: 'The current cycle needs a Linear API key for this workspace. Add one in the panel’s settings.',
  unauthenticated: 'Linear refused the API key. Paste a new one from Linear → Settings → Security & access.',
  rateLimited: 'Linear asked to slow down. Trying again in a moment.',
  notFound: 'That issue was not found.'
})

export const bad = (message) => new LinearError('invalid', message)

const KINDS = ['no-cli', 'not-connected', 'unauthenticated', 'unsupported', 'invalid', 'not-found', 'rate-limited', 'error']

export function asLinearError(error) {
  if (error instanceof LinearError) return error
  if (KINDS.includes(error?.kind)) return new LinearError(error.kind, String(error.message), error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : undefined)
  return new LinearError('error', String(error?.message || error).trim() || 'Something went wrong.')
}

// What a panel handler sends back when a call fails: plain JSON.
export const errorReply = (error) => {
  const e = asLinearError(error)
  const reply = { error: { kind: e.kind, message: e.message } }
  if (e.retryAfterMs !== undefined) reply.error.retryAfterMs = e.retryAfterMs
  return reply
}
