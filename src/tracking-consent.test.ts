import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isStorageAvailable, makeStorageKey } from './utils.js'

const logSpies = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

vi.mock('./logger.js', () => ({ log: logSpies }))

// Keep the real makeStorageKey; make isStorageAvailable controllable per test.
vi.mock('./utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./utils.js')>()
  return { ...actual, isStorageAvailable: vi.fn(() => true) }
})

const KEY = makeStorageKey('proj', 'consent')

// Dynamic import so the mocked logger is wired up before the module loads
// (matches the pattern in pug.test.ts).
const loadFactory = async () => (await import('./tracking-consent.js')).createTrackingConsent

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isStorageAvailable).mockReturnValue(true)
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createTrackingConsent', () => {
  it('defaults to granted with no config', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj')
    expect(consent.isGranted()).toBe(true)
    expect(consent.getConsent()).toBe('granted')
  })

  it('honors the default seed from the object form', async () => {
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', { default: 'denied' }).getConsent()).toBe('denied')
  })

  it('honors the default seed from the string shorthand', async () => {
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', 'denied').getConsent()).toBe('denied')
  })

  it('does not touch storage when persist is false', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { default: 'granted' })
    consent.optOut()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('writes granted to storage on optIn when persist is true', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { default: 'denied', persist: true })
    consent.optIn()
    expect(localStorage.getItem(KEY)).toBe('granted')
  })

  it('writes denied to storage on optOut when persist is true', async () => {
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { default: 'granted', persist: true })
    consent.optOut()
    expect(localStorage.getItem(KEY)).toBe('denied')
  })

  it('restores a persisted value over the default seed', async () => {
    localStorage.setItem(KEY, 'denied')
    const createTrackingConsent = await loadFactory()
    expect(createTrackingConsent('proj', { default: 'granted', persist: true }).getConsent()).toBe('denied')
  })

  it('ignores an invalid persisted value and warns', async () => {
    localStorage.setItem(KEY, 'maybe')
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { default: 'granted', persist: true })
    expect(consent.getConsent()).toBe('granted')
    expect(logSpies.warn).toHaveBeenCalledWith(`Stored tracking consent "maybe" at "${KEY}" is invalid, ignoring.`)
  })

  it('falls back to in-memory and warns when storage is unavailable', async () => {
    vi.mocked(isStorageAvailable).mockReturnValue(false)
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { default: 'denied', persist: true })
    consent.optIn()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(consent.getConsent()).toBe('granted')
    expect(logSpies.warn).toHaveBeenCalledWith(
      'Storage unavailable; tracking consent will not persist across page loads.',
    )
  })

  it('falls back to the seed and warns when reading storage throws', async () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('read boom')
    })
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { default: 'denied', persist: true })
    expect(consent.getConsent()).toBe('denied')
    expect(logSpies.warn).toHaveBeenCalledWith('Failed to read tracking consent from storage:', expect.any(Error))
  })

  it('does not throw and logs an error when persisting throws', async () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('write boom')
    })
    const createTrackingConsent = await loadFactory()
    const consent = createTrackingConsent('proj', { default: 'granted', persist: true })
    expect(() => consent.optOut()).not.toThrow()
    expect(consent.getConsent()).toBe('denied')
    expect(logSpies.error).toHaveBeenCalledWith(
      'Failed to persist tracking consent to storage — opt in/out will not survive page reload:',
      expect.any(Error),
    )
  })
})
