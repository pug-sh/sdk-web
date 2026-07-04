import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CookieLayer } from './cookie.js'
import { createPersistentStore, resolveStore } from './persistence.js'
import { isStorageAvailable } from './utils.js'

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('./logger.js', () => ({ log: logSpies }))

vi.mock('./utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./utils.js')>()
  return { ...actual, isStorageAvailable: vi.fn(() => true) }
})

const createFakeCookieLayer = (crossSubdomain = true) => {
  const jar = new Map<string, string>()
  const layer: CookieLayer = {
    crossSubdomain,
    get: key => jar.get(key) ?? null,
    set: (key, value) => {
      jar.set(key, value)
      return true
    },
    remove: key => {
      jar.delete(key)
    },
  }
  return { layer, jar }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isStorageAvailable).mockReturnValue(true)
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createPersistentStore', () => {
  it('returns null when neither cookies nor localStorage are usable', () => {
    vi.mocked(isStorageAvailable).mockReturnValue(false)
    expect(createPersistentStore(null)).toBeNull()
  })

  it('works localStorage-only when the cookie layer is absent', () => {
    const store = createPersistentStore(null)
    expect(store?.crossSubdomain).toBe(false)
    expect(store?.setItem('k', 'v')).toBe(true)
    expect(localStorage.getItem('k')).toBe('v')
    expect(store?.getItem('k')).toBe('v')
    store?.removeItem('k')
    expect(store?.getItem('k')).toBeNull()
  })

  it('propagates the crossSubdomain flag from the cookie layer', () => {
    expect(createPersistentStore(createFakeCookieLayer(true).layer)?.crossSubdomain).toBe(true)
    expect(createPersistentStore(createFakeCookieLayer(false).layer)?.crossSubdomain).toBe(false)
  })

  it('writes to both layers', () => {
    const { layer, jar } = createFakeCookieLayer()
    const store = createPersistentStore(layer)
    expect(store?.setItem('k', 'v')).toBe(true)
    expect(jar.get('k')).toBe('v')
    expect(localStorage.getItem('k')).toBe('v')
  })

  it('prefers the cookie value over a conflicting localStorage value', () => {
    const { layer } = createFakeCookieLayer()
    const store = createPersistentStore(layer)
    localStorage.setItem('k', 'stale-local')
    layer.set('k', 'shared-cookie')
    expect(store?.getItem('k')).toBe('shared-cookie')
  })

  it('does not fall back to localStorage on a cookie miss in cross-subdomain mode', () => {
    // The shared cookie is authoritative; a miss must not resurrect a sibling origin's stale value.
    const store = createPersistentStore(createFakeCookieLayer(true).layer)
    localStorage.setItem('k', 'stale-sibling')
    expect(store?.getItem('k')).toBeNull()
  })

  it('falls back to localStorage on a cookie miss for a host-only store', () => {
    const store = createPersistentStore(createFakeCookieLayer(false).layer)
    localStorage.setItem('k', 'local-only')
    expect(store?.getItem('k')).toBe('local-only')
  })

  it('warns once when a cross-subdomain cookie write is silently dropped', () => {
    const { layer } = createFakeCookieLayer(true)
    layer.set = () => false
    const store = createPersistentStore(layer)
    store?.setItem('k', 'v')
    store?.setItem('k', 'v2')
    expect(logSpies.warn).toHaveBeenCalledTimes(1)
    expect(logSpies.warn).toHaveBeenCalledWith(
      'Cross-subdomain cookie for "k" did not persist; this value will not survive a page load.',
    )
  })

  it('does not warn about dropped cookie writes for a host-only store', () => {
    const { layer } = createFakeCookieLayer(false)
    layer.set = () => false
    const store = createPersistentStore(layer)
    store?.setItem('k', 'v')
    expect(logSpies.warn).not.toHaveBeenCalled()
  })

  it('removes from both layers', () => {
    const { layer, jar } = createFakeCookieLayer()
    const store = createPersistentStore(layer)
    store?.setItem('k', 'v')
    store?.removeItem('k')
    expect(jar.has('k')).toBe(false)
    expect(localStorage.getItem('k')).toBeNull()
  })

  it('reports success when only the cookie write lands', () => {
    const { layer } = createFakeCookieLayer()
    const store = createPersistentStore(layer)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(store?.setItem('k', 'v')).toBe(true)
    expect(logSpies.warn).toHaveBeenCalledWith('Failed to write "k" to localStorage:', expect.any(Error))
  })

  it('reports success when only the localStorage write lands for a host-only store', () => {
    const { layer } = createFakeCookieLayer(false)
    layer.set = () => false
    const store = createPersistentStore(layer)
    expect(store?.setItem('k', 'v')).toBe(true)
    expect(localStorage.getItem('k')).toBe('v')
  })

  it('reports failure in cross-subdomain mode when the cookie write fails, even if localStorage lands', () => {
    // getItem never falls back to localStorage in this mode, so a localStorage-only success is
    // unreadable on the next load and must not be reported as persisted.
    const { layer } = createFakeCookieLayer(true)
    layer.set = () => false
    const store = createPersistentStore(layer)
    expect(store?.setItem('k', 'v')).toBe(false)
    expect(localStorage.getItem('k')).toBe('v')
  })

  it('reports failure when every layer fails', () => {
    const { layer } = createFakeCookieLayer()
    layer.set = () => false
    const store = createPersistentStore(layer)
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(store?.setItem('k', 'v')).toBe(false)
  })

  it('warns and returns null when a localStorage read throws', () => {
    const store = createPersistentStore(null)
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('read boom')
    })
    expect(store?.getItem('k')).toBeNull()
    expect(logSpies.warn).toHaveBeenCalledWith('Failed to read "k" from localStorage:', expect.any(Error))
  })
})

describe('resolveStore', () => {
  it('builds a localStorage-only store when the argument is omitted (undefined)', () => {
    const store = resolveStore()
    expect(store).not.toBeNull()
    expect(store?.crossSubdomain).toBe(false)
  })

  it('returns null when explicitly passed null (init found no usable layer)', () => {
    expect(resolveStore(null)).toBeNull()
  })

  it('returns a provided store unchanged', () => {
    const provided = createPersistentStore(createFakeCookieLayer(true).layer)
    expect(resolveStore(provided)).toBe(provided)
  })
})
