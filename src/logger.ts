const PREFIX = '[Pug SDK]'

const safeConsole =
  (method: 'warn' | 'error' | 'debug') =>
  (msg: string, ...args: unknown[]): void => {
    try {
      console[method](`${PREFIX} ${msg}`, ...args)
    } catch {
      // Covers console being absent, the method missing, or a site's console patch throwing (even
      // on property access) — none of which may break the SDK's never-throw guarantees. An
      // unloggable log is the one legitimately silent drop.
    }
  }

let debugEnabled = false

/**
 * Toggles the `debug` channel, which is off by default so an integration does not narrate every
 * event into a host application's console. `init({ debug: true })` turns it on; `destroy()` resets
 * it. `warn` and `error` are never gated — they report things an integrator needs to see regardless.
 */
export const setDebugLogging = (enabled: boolean): void => {
  debugEnabled = enabled
}

const writeDebug = safeConsole('debug')

export const log = {
  warn: safeConsole('warn'),
  error: safeConsole('error'),
  debug: (msg: string, ...args: unknown[]): void => {
    if (!debugEnabled) {
      return
    }
    writeDebug(msg, ...args)
  },
}
