const PREFIX = '[Cotton SDK]'

export const log = {
  warn: (msg: string, ...args: unknown[]): void => {
    console.warn(`${PREFIX} ${msg}`, ...args)
  },
  error: (msg: string, ...args: unknown[]): void => {
    console.error(`${PREFIX} ${msg}`, ...args)
  },
  debug: (msg: string, ...args: unknown[]): void => {
    console.debug(`${PREFIX} ${msg}`, ...args)
  },
}
