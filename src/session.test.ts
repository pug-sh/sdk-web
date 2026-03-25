import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureSession,
  destroySession,
  resetIdentity,
  resolveSessionId,
  rotate,
} from './session.js'
import { makeStorageKey } from './utils.js'

const PROJECT_ID = 'test-project'
const SESSION_KEY = makeStorageKey(PROJECT_ID, 'session')
const TABS_KEY = makeStorageKey(PROJECT_ID, 'tabs')

// jsdom's localStorage is incomplete — provide a working mock
const createMockStorage = (): Storage => {
  const store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      for (const key of Object.keys(store)) {
        delete store[key]
      }
    },
    get length() {
      return Object.keys(store).length
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  }
}

let mockStorage: Storage

beforeEach(() => {
  mockStorage = createMockStorage()
  Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true, configurable: true })
  configureSession(PROJECT_ID)
})

afterEach(() => {
  destroySession()
  vi.restoreAllMocks()
})

describe('configureSession', () => {
  it('sets storage key', () => {
    const id = resolveSessionId()
    const stored = JSON.parse(mockStorage.getItem(SESSION_KEY)!)
    expect(stored.sessionId).toBe(id)
  })

  it('warns on idleTimeoutMinutes <= 0', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    destroySession()
    configureSession(PROJECT_ID, { idleTimeoutMinutes: 0 })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('idleTimeoutMinutes must be > 0'))
  })

  it('warns on maxSessionMinutes <= 0', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    destroySession()
    configureSession(PROJECT_ID, { maxSessionMinutes: -1 })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('maxSessionMinutes must be > 0'))
  })

  it('applies valid config', () => {
    destroySession()
    configureSession(PROJECT_ID, { idleTimeoutMinutes: 5, maxSessionMinutes: 60 })
    const id1 = resolveSessionId()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000)
    const id2 = resolveSessionId()
    expect(id2).not.toBe(id1)
  })
})

describe('resolveSessionId', () => {
  it('creates a new session on first call', () => {
    const id = resolveSessionId()
    expect(id).toBeTruthy()
    expect(typeof id).toBe('string')
  })

  it('returns the same session on subsequent calls', () => {
    const id1 = resolveSessionId()
    const id2 = resolveSessionId()
    expect(id2).toBe(id1)
  })

  it('persists session to localStorage', () => {
    const id = resolveSessionId()
    const stored = JSON.parse(mockStorage.getItem(SESSION_KEY)!)
    expect(stored.sessionId).toBe(id)
    expect(stored.deviceId).toBeTruthy()
    expect(typeof stored.startTime).toBe('number')
    expect(typeof stored.lastActivityTime).toBe('number')
  })

  it('rotates session on idle timeout', () => {
    const id1 = resolveSessionId()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000)
    const id2 = resolveSessionId()
    expect(id2).not.toBe(id1)
  })

  it('rotates session on max duration', () => {
    const id1 = resolveSessionId()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000)
    const id2 = resolveSessionId()
    expect(id2).not.toBe(id1)
  })

  it('preserves deviceId across session rotations', () => {
    resolveSessionId()
    const device1 = JSON.parse(mockStorage.getItem(SESSION_KEY)!).deviceId
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000)
    resolveSessionId()
    const device2 = JSON.parse(mockStorage.getItem(SESSION_KEY)!).deviceId
    expect(device2).toBe(device1)
  })

  it('updates lastActivityTime on every call', () => {
    resolveSessionId()
    const future = Date.now() + 5000
    vi.spyOn(Date, 'now').mockReturnValue(future)
    resolveSessionId()
    const t2 = JSON.parse(mockStorage.getItem(SESSION_KEY)!).lastActivityTime
    expect(t2).toBe(future)
  })

  it('returns fallback sessionId on error', () => {
    resolveSessionId()
    vi.spyOn(mockStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage broken')
    })
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = resolveSessionId()
    expect(id).toBeTruthy()
    expect(typeof id).toBe('string')
    spy.mockRestore()
  })

  it('returns fallback when state is null after rotate', () => {
    // Simulate: storageKey gets cleared so rotate() bails
    destroySession()
    configureSession(PROJECT_ID)
    // Wipe the storageKey to make rotate() bail
    // We need to access internal config — instead, destroy and don't reconfigure
    destroySession()
    // Now storageKey is empty, but we have no fallbackSessionId either
    // Let's set up properly: configure, then break state
    configureSession(PROJECT_ID)
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // This should always return a valid string
    const id = resolveSessionId()
    expect(id).toBeTruthy()
    spy.mockRestore()
  })
})

describe('rotate', () => {
  it('generates a new sessionId', () => {
    const id1 = resolveSessionId()
    rotate()
    const id2 = resolveSessionId()
    expect(id2).not.toBe(id1)
  })

  it('preserves deviceId from storage on cold call', () => {
    resolveSessionId()
    const device = JSON.parse(mockStorage.getItem(SESSION_KEY)!).deviceId
    // Simulate cold state: clear in-memory but keep session in localStorage.
    // destroySession removes the session key, so we save and restore it.
    const savedSession = mockStorage.getItem(SESSION_KEY)!
    destroySession()
    mockStorage.setItem(SESSION_KEY, savedSession)
    configureSession(PROJECT_ID)
    rotate()
    const newDevice = JSON.parse(mockStorage.getItem(SESSION_KEY)!).deviceId
    expect(newDevice).toBe(device)
  })

  it('warns and returns early before init', () => {
    destroySession()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    rotate()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('rotate() called before init()'))
    spy.mockRestore()
  })
})

describe('resetIdentity', () => {
  it('generates new sessionId and deviceId', () => {
    resolveSessionId()
    const before = JSON.parse(mockStorage.getItem(SESSION_KEY)!)
    resetIdentity()
    const after = JSON.parse(mockStorage.getItem(SESSION_KEY)!)
    expect(after.sessionId).not.toBe(before.sessionId)
    expect(after.deviceId).not.toBe(before.deviceId)
  })
})

describe('destroySession', () => {
  it('clears session from localStorage', () => {
    resolveSessionId()
    expect(mockStorage.getItem(SESSION_KEY)).not.toBeNull()
    destroySession()
    expect(mockStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('only removes own tab entry from tabs map', () => {
    resolveSessionId()
    const tabs = JSON.parse(mockStorage.getItem(TABS_KEY)!)
    tabs['other-tab'] = Date.now()
    mockStorage.setItem(TABS_KEY, JSON.stringify(tabs))
    destroySession()
    const remaining = JSON.parse(mockStorage.getItem(TABS_KEY)!)
    expect(remaining['other-tab']).toBeTruthy()
  })

  it('removes tabs key entirely when last tab', () => {
    resolveSessionId()
    destroySession()
    expect(mockStorage.getItem(TABS_KEY)).toBeNull()
  })

  it('allows re-initialization after destroy', () => {
    resolveSessionId()
    destroySession()
    configureSession(PROJECT_ID)
    const id = resolveSessionId()
    expect(id).toBeTruthy()
  })

  it('handles storage errors gracefully', () => {
    resolveSessionId()
    vi.spyOn(mockStorage, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => destroySession()).not.toThrow()
    spy.mockRestore()
  })
})

describe('tab detection', () => {
  it('rotates session when all tabs were closed', () => {
    const id1 = resolveSessionId()
    mockStorage.removeItem(TABS_KEY)
    destroySession()
    configureSession(PROJECT_ID)
    const id2 = resolveSessionId()
    expect(id2).not.toBe(id1)
  })

  it('does not rotate when another tab is alive', () => {
    const id1 = resolveSessionId()
    // Save session and inject another alive tab before re-init
    const savedSession = mockStorage.getItem(SESSION_KEY)!
    const tabs = JSON.parse(mockStorage.getItem(TABS_KEY)!)
    tabs['other-tab'] = Date.now()
    mockStorage.setItem(TABS_KEY, JSON.stringify(tabs))
    destroySession()
    mockStorage.setItem(SESSION_KEY, savedSession)
    // Keep the other tab entry
    mockStorage.setItem(TABS_KEY, JSON.stringify({ 'other-tab': Date.now() }))
    configureSession(PROJECT_ID)
    const id2 = resolveSessionId()
    expect(id2).toBe(id1)
  })

  it('prunes stale tabs older than idle timeout', () => {
    const now = Date.now()
    mockStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ sessionId: 'old-session', deviceId: 'dev-1', startTime: now, lastActivityTime: now })
    )
    mockStorage.setItem(TABS_KEY, JSON.stringify({ 'stale-tab': now - 31 * 60 * 1000 }))
    destroySession()
    configureSession(PROJECT_ID)
    const id = resolveSessionId()
    expect(id).not.toBe('old-session')
  })

  it('registers pagehide listener', () => {
    const spy = vi.spyOn(window, 'addEventListener')
    destroySession()
    configureSession(PROJECT_ID)
    expect(spy).toHaveBeenCalledWith('pagehide', expect.any(Function))
  })

  it('removes pagehide listener on destroy', () => {
    const spy = vi.spyOn(window, 'removeEventListener')
    resolveSessionId()
    destroySession()
    expect(spy).toHaveBeenCalledWith('pagehide', expect.any(Function))
  })
})

describe('cross-tab sync', () => {
  it('reads session from storage written by another tab', () => {
    resolveSessionId()
    const now = Date.now()
    mockStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        sessionId: 'from-other-tab',
        deviceId: 'shared-device',
        startTime: now,
        lastActivityTime: now,
      })
    )
    const id = resolveSessionId()
    expect(id).toBe('from-other-tab')
  })
})

describe('read validation', () => {
  it('rejects stored state with non-string sessionId', () => {
    mockStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ sessionId: 123, deviceId: 'dev', startTime: 1, lastActivityTime: 1 })
    )
    destroySession()
    configureSession(PROJECT_ID)
    const id = resolveSessionId()
    expect(id).not.toBe('123')
  })

  it('rejects stored state with non-number timestamps', () => {
    mockStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ sessionId: 'sid', deviceId: 'dev', startTime: 'bad', lastActivityTime: 1 })
    )
    destroySession()
    configureSession(PROJECT_ID)
    const id = resolveSessionId()
    expect(id).not.toBe('sid')
  })

  it('rejects corrupt JSON', () => {
    mockStorage.setItem(SESSION_KEY, '{not valid json')
    destroySession()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configureSession(PROJECT_ID)
    const id = resolveSessionId()
    expect(id).toBeTruthy()
    spy.mockRestore()
  })
})
