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

export const log = {
  warn: safeConsole('warn'),
  error: safeConsole('error'),
  debug: safeConsole('debug'),
}
