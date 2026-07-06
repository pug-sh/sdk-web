// Vitest setup: provide an in-memory localStorage / sessionStorage.
//
// vitest's jsdom environment (jsdom 29) does not expose Storage here, so the
// SDK's storage-backed code (session, profile, tracking-consent) would have
// nothing to read or write against. This installs a minimal in-memory Storage
// that matches browser semantics closely enough to exercise that behavior.

import { beforeEach } from 'vitest'

// jsdom keeps one cookie jar per test file, so cookies written by the SDK's
// cookie layer would leak between tests. Expire them all before each test.
beforeEach(() => {
  if (typeof document === 'undefined') {
    return
  }
  for (const part of document.cookie.split('; ')) {
    const name = part.split('=')[0]
    if (name) {
      document.cookie = `${name}=; path=/; max-age=0`
    }
  }
})

const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>()
  const storage = {
    get length(): number {
      return store.size
    },
    clear(): void {
      store.clear()
    },
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key: string): void {
      store.delete(key)
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value))
    },
  }
  return storage as unknown as Storage
}

const installStorage = (prop: 'localStorage' | 'sessionStorage'): void => {
  // Install unconditionally rather than reading the existing global first —
  // reading `globalThis.localStorage` would trip Node's experimental-localStorage
  // warning. vitest's jsdom exposes no Storage here, so there is nothing real to
  // preserve. defineProperty replaces any descriptor without invoking its getter.
  const storage = createMemoryStorage()
  Object.defineProperty(globalThis, prop, { value: storage, configurable: true, writable: true })
  const win = (globalThis as Record<string, unknown>).window as (Record<string, unknown> & object) | undefined
  if (win != null && win !== globalThis) {
    Object.defineProperty(win, prop, { value: storage, configurable: true, writable: true })
  }
}

installStorage('localStorage')
installStorage('sessionStorage')
