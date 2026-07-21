import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeStorageKey } from './utils.js'

// Only the wire is mocked — everything between track() and the transport
// (consent, session, profile, persistence, batching) is real, so this suite
// catches ANY code path that writes to the device in cookieless mode.
const { sendBatch, send, beacon } = vi.hoisted(() => ({
  sendBatch: vi.fn(() => Promise.resolve({ accepted: 1 })),
  send: vi.fn(() => Promise.resolve({ accepted: 1 })),
  beacon: vi.fn(() => true),
}))
vi.mock('./transport.js', () => ({ createTransport: () => ({ send, sendBatch, beacon }) }))

const { init, track, destroy, setTrackingConsent } = await import('./pug.js')

/**
 * The write/remove sentinel isStorageAvailable() uses to probe localStorage. It is a capability
 * probe, not data: written and removed synchronously, never carrying a value about the user, and
 * exactly analogous to the cookie layer's `max-age=3` probe. Excluded from the write assertions
 * below on that basis — but excluded *by name*, so anything else the SDK writes still fails.
 */
const PROBE_KEY = makeStorageKey('_', 'probe')

/**
 * Records every localStorage mutation as it happens.
 *
 * Inspecting `localStorage` at the end of a test is not enough: the batch queue removes its key once
 * the buffer drains (commit → persist → removeItem on empty), so a queue that persisted cookieless
 * payloads and then tidied up looks identical to one that never wrote. Replacing `storageFor` with
 * `() => storage` — routing every cookieless event straight to the persisted queue, the exact
 * regression this feature prevents — left the end-state assertions passing.
 *
 * Spying on the *instance* is load-bearing: in this jsdom environment a
 * `vi.spyOn(Storage.prototype, 'setItem')` never fires, so a prototype-level version of this helper
 * would record nothing and every assertion below would pass unconditionally.
 */
const recordDeviceWrites = () => {
  const writes: string[] = []
  const removals: string[] = []
  const realSet = localStorage.setItem.bind(localStorage)
  const realRemove = localStorage.removeItem.bind(localStorage)
  vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
    if (key !== PROBE_KEY) {
      writes.push(key)
    }
    realSet(key, value)
  })
  vi.spyOn(localStorage, 'removeItem').mockImplementation((key: string) => {
    removals.push(key)
    realRemove(key)
  })
  return { writes, removals }
}

/** jsdom's Storage exposes its methods as own enumerable properties, so Object.keys() is useless here. */
const storedKeys = (): string[] =>
  Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
    (k): k is string => k !== null && k !== PROBE_KEY,
  )

const sentEvents = () => sendBatch.mock.calls.flatMap(call => (call as unknown as [unknown[]])[0])

afterEach(() => {
  vi.useRealTimers()
  destroy()
  vi.restoreAllMocks()
  localStorage.clear()
  for (const c of document.cookie.split(';')) {
    document.cookie = `${c.split('=')[0].trim()}=; max-age=0; path=/`
  }
  vi.clearAllMocks()
})

describe('cookieless storage silence', () => {
  it('a full cookieless session writes nothing to the device, even transiently', async () => {
    vi.useFakeTimers()
    const { writes } = recordDeviceWrites()
    // crossSubdomainTracking on purpose: without it createCookieLayer returns null and no cookie
    // layer is ever constructed, so a `document.cookie` assertion cannot fail under any
    // implementation. With it, the cookie path is live and the assertion means something.
    init('proj-silence', { apiKey: 'k', trackingConsent: 'cookieless', crossSubdomainTracking: true })
    track('page_view')
    track('click', { x: 1 })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(writes).toEqual([])
    expect(storedKeys()).toEqual([])
    expect(document.cookie).toBe('')
  })

  // Silence is trivially achieved by doing nothing, so every silence assertion above is only
  // meaningful alongside proof that the events actually left.
  it('cookieless events still flow while nothing is stored', async () => {
    vi.useFakeTimers()
    // autoCapture off so the count is exactly the manual tracks below — otherwise the controller's
    // own page_view (listeners run in cookieless: they gate on isTracking, not isGranted) is in here.
    init('proj-flow', { apiKey: 'k', trackingConsent: 'cookieless', autoCapture: false })
    track('page_view')
    track('click', { x: 1 })
    await vi.advanceTimersByTimeAsync(10_000)

    const sent = sentEvents() as Array<{ cookieless: boolean; sessionId: string; distinctId: string }>
    expect(sent).toHaveLength(2)
    expect(sent.every(e => e.cookieless === true)).toBe(true)
    expect(sent.every(e => e.sessionId === '' && e.distinctId === '')).toBe(true)
  })

  // C2: the purge on leaving 'granted' removed the session key but left the tab registry — still
  // holding the tabId → timestamp pair written while consent was granted — and left the pagehide
  // reaper attached, so the SDK wrote to the device *again* on the way out, while advertising that
  // it stores nothing. configureSession's isGranted check guards creation only, and consent became
  // runtime-mutable when setTrackingConsent shipped.
  it('granted → cookieless purges identity and stays silent through pagehide', async () => {
    vi.useFakeTimers()
    init('proj-transition', { apiKey: 'k', trackingConsent: 'granted' })
    track('page_view')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(storedKeys().length).toBeGreaterThan(0)

    const { writes } = recordDeviceWrites()
    setTrackingConsent('cookieless')
    expect(storedKeys()).toEqual([])

    track('click')
    window.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(10_000)

    expect(writes).toEqual([])
    expect(storedKeys()).toEqual([])
  })

  it('opting out from granted leaves nothing behind either', async () => {
    vi.useFakeTimers()
    init('proj-optout', { apiKey: 'k', trackingConsent: 'granted' })
    track('page_view')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(storedKeys().length).toBeGreaterThan(0)

    setTrackingConsent('denied')
    window.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(10_000)

    expect(storedKeys()).toEqual([])
  })

  // I1: "stores nothing on the device" is absolute in the docs, but the README's own recommended
  // banner recipe persists the consent record. That exception is deliberate and legally defensible
  // (a strictly-necessary record of the user's refusal) — pinned here so it stays deliberate, and
  // so the docs and the code cannot drift apart silently.
  it('the documented persist:true recipe stores the consent record and nothing else', async () => {
    vi.useFakeTimers()
    const consentKey = makeStorageKey('proj-persist', 'consent')

    const { writes } = recordDeviceWrites()
    init('proj-persist', { apiKey: 'k', trackingConsent: { default: 'cookieless', persist: true } })
    track('page_view')
    await vi.advanceTimersByTimeAsync(10_000)
    // The first-run seed is never persisted — only an explicit set() is.
    expect(writes).toEqual([])

    setTrackingConsent('cookieless')
    expect(localStorage.getItem(consentKey)).toBe('cookieless')
    expect(storedKeys()).toEqual([consentKey])
  })

  // I3: entering cookieless via config must leave the device in the same state as entering it via
  // setTrackingConsent(), or a visitor whose CMP now says "reject" keeps a prior consented visit's
  // 365-day identifiers, and the documented "granting later mints a fresh identity" is false.
  it('re-initializing with a recorded non-granted choice purges leftover identity', async () => {
    vi.useFakeTimers()
    const p = 'proj-reinit'
    init(p, { apiKey: 'k', trackingConsent: { default: 'granted', persist: true } })
    track('page_view')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(localStorage.getItem(makeStorageKey(p, 'session'))).not.toBeNull()
    expect(localStorage.getItem(makeStorageKey(p, 'profile'))).not.toBeNull()
    destroy()

    // The user rejects analytics cookies, and that choice is recorded. Identity is written here
    // directly rather than via setTrackingConsent, so this tests init()'s purge specifically — the
    // state a returning visitor lands in when an earlier purge was incomplete or the identity
    // predates the consent config.
    localStorage.setItem(makeStorageKey(p, 'consent'), 'cookieless')

    init(p, { apiKey: 'k', trackingConsent: { default: 'granted', persist: true } })

    expect(localStorage.getItem(makeStorageKey(p, 'session'))).toBeNull()
    expect(localStorage.getItem(makeStorageKey(p, 'profile'))).toBeNull()
    expect(localStorage.getItem(makeStorageKey(p, 'tabs'))).toBeNull()
  })

  // The init-time purge is gated on the resolved consent actually having come FROM STORAGE, not
  // merely on persist:true. Nothing is written to the consent key until an explicit set(), so a
  // site adding `{ default: 'denied', persist: true }` to an existing deployment would otherwise
  // find an empty key on every returning visitor's first load, fall back to the seed, and delete
  // identity those users never asked to have deleted — once, for the entire user base, on deploy day.
  it('does not purge identity for a seed the user never chose', async () => {
    vi.useFakeTimers()
    const p = 'proj-seed'
    init(p, { apiKey: 'k', trackingConsent: { default: 'granted', persist: true } })
    track('page_view')
    await vi.advanceTimersByTimeAsync(10_000)
    const profile = localStorage.getItem(makeStorageKey(p, 'profile'))
    expect(profile).not.toBeNull()
    destroy()

    // No consent value was ever recorded — only the integrator's new default.
    expect(localStorage.getItem(makeStorageKey(p, 'consent'))).toBeNull()
    init(p, { apiKey: 'k', trackingConsent: { default: 'denied', persist: true } })

    expect(localStorage.getItem(makeStorageKey(p, 'profile'))).toBe(profile)
  })

  it('the same flow under granted consent does persist identity (control)', async () => {
    vi.useFakeTimers()
    init('proj-control', { apiKey: 'k', trackingConsent: 'granted' })
    track('page_view')
    await vi.advanceTimersByTimeAsync(10_000)

    // Naming the keys matters: `localStorage.length > 0` was satisfied by the tab registry alone, so
    // a regression that stopped persisting identity under granted consent left the canary green.
    expect(localStorage.getItem(makeStorageKey('proj-control', 'session'))).not.toBeNull()
    expect(localStorage.getItem(makeStorageKey('proj-control', 'profile'))).not.toBeNull()
  })
})
