/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://app.example.test/" }
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GrpcCode, RpcError } from './rpc.js'
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

const { init, track, destroy, setTrackingConsent, optOutTracking, optInTracking, reset } = await import('./pug.js')
const { rotate } = await import('./session.js')

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

  // Cookies need the same treatment as localStorage, and for the same reason the comment above
  // gives: `expect(document.cookie).toBe('')` is an END-STATE check, so a write followed by a
  // delete passes it. Every cookie the layer writes goes through a `doc.cookie = ...` assignment,
  // so intercepting the setter records them as they happen. Deletions (max-age=0) and the layer's
  // own transient capability probes are excluded by shape and by name, exactly as PROBE_KEY is.
  const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
  if (cookieDesc?.get && cookieDesc.set) {
    const { get, set } = cookieDesc
    vi.spyOn(document, 'cookie', 'set').mockImplementation((value: string) => {
      const name = String(value).split('=')[0].trim()
      const isDeletion = /max-age=0|expires=Thu, 01 Jan 1970/i.test(value)
      if (!isDeletion && !name.startsWith('__pug_probe_')) {
        writes.push(`cookie:${name}`)
      }
      set.call(document, value)
    })
    vi.spyOn(document, 'cookie', 'get').mockImplementation(() => get.call(document) as string)
  }
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
  // clearAllMocks() resets recorded calls but NOT implementations, so a mockRejectedValue set by one
  // test would silently follow every later one. Put the wire back to its default explicitly.
  sendBatch.mockResolvedValue({ accepted: 1 })
  beacon.mockReturnValue(true)
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
    init('proj-persist', { apiKey: 'k', trackingConsent: { initial: 'cookieless', persist: true } })
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
    init(p, { apiKey: 'k', trackingConsent: { initial: 'granted', persist: true } })
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

    init(p, { apiKey: 'k', trackingConsent: { initial: 'granted', persist: true } })

    expect(localStorage.getItem(makeStorageKey(p, 'session'))).toBeNull()
    expect(localStorage.getItem(makeStorageKey(p, 'profile'))).toBeNull()
    // Weak on its own: destroy() above already dropped this key via the purge:false path, so this
    // passes whether or not the purge touches the registry. The two cases below are the real guard.
    expect(localStorage.getItem(makeStorageKey(p, 'tabs'))).toBeNull()
  })

  // The purge must not depend on THIS page having armed the registry. When consent resolves
  // non-granted at init(), armTabRegistry() returns before setting tabsStorage/tabsKey/tabId — so a
  // purge keyed on those handles silently does nothing in exactly the state that runs the purge,
  // and reports success. A prior tab killed without pagehide leaves the key behind for this to find.
  it('purges a tab registry this page never armed', () => {
    const p = 'proj-stale-tabs'
    localStorage.setItem(makeStorageKey(p, 'consent'), 'denied')
    localStorage.setItem(makeStorageKey(p, 'profile'), 'anon-0190abc')
    localStorage.setItem(makeStorageKey(p, 'tabs'), JSON.stringify({ deadtab: Date.now() }))

    init(p, { apiKey: 'k', trackingConsent: { initial: 'granted', persist: true } })

    expect(localStorage.getItem(makeStorageKey(p, 'profile'))).toBeNull()
    expect(localStorage.getItem(makeStorageKey(p, 'tabs'))).toBeNull()
  })

  it('purges an unarmed tab registry through a runtime transition too', () => {
    const p = 'proj-stale-tabs-runtime'
    localStorage.setItem(makeStorageKey(p, 'tabs'), JSON.stringify({ deadtab: Date.now() }))
    init(p, { apiKey: 'k', trackingConsent: 'cookieless' })

    expect(optOutTracking()).toBe(true)
    expect(localStorage.getItem(makeStorageKey(p, 'tabs'))).toBeNull()
  })

  // The init-time purge is gated on the resolved consent actually having come FROM STORAGE, not
  // merely on persist:true. Nothing is written to the consent key until an explicit set(), so a
  // site adding `{ initial: 'denied', persist: true }` to an existing deployment would otherwise
  // find an empty key on every returning visitor's first load, fall back to the seed, and delete
  // identity those users never asked to have deleted — once, for the entire user base, on deploy day.
  it('does not purge identity for a seed the user never chose', async () => {
    vi.useFakeTimers()
    const p = 'proj-seed'
    init(p, { apiKey: 'k', trackingConsent: { initial: 'granted', persist: true } })
    track('page_view')
    await vi.advanceTimersByTimeAsync(10_000)
    const profile = localStorage.getItem(makeStorageKey(p, 'profile'))
    expect(profile).not.toBeNull()
    destroy()

    // No consent value was ever recorded — only the integrator's new default.
    expect(localStorage.getItem(makeStorageKey(p, 'consent'))).toBeNull()
    init(p, { apiKey: 'k', trackingConsent: { initial: 'denied', persist: true } })

    expect(localStorage.getItem(makeStorageKey(p, 'profile'))).toBe(profile)
  })

  // The batch queue is device storage too, and it serializes sessionId + distinctId on every event
  // — after identify(), distinctId IS the externalId. It was never wired into the consent teardown,
  // so a withdrawal left identified payloads on the device and beaconed them on a later visit.
  //
  // Buffering requires a transiently-failing send: on the happy path the queue drains and removes
  // its own key, which is exactly why the assertions elsewhere in this file could not see the gap.
  // Rejection must be sustained, not once: after a rollback the state machine immediately reschedules,
  // so a single failure is retried and drains on the next attempt, taking the queue key with it.
  const bufferOneConsentedEvent = async (p: string) => {
    sendBatch.mockRejectedValue(new RpcError('down', GrpcCode.Unavailable))
    init(p, { apiKey: 'k', trackingConsent: 'granted', autoCapture: false, batch: { maxWaitMs: 100 } })
    track('purchase', { amount: 42 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(localStorage.getItem(makeStorageKey(p, 'queue'))).not.toBeNull()
  }

  it('opting out purges the persisted event queue', async () => {
    vi.useFakeTimers()
    const p = 'proj-queue-optout'
    await bufferOneConsentedEvent(p)

    expect(optOutTracking()).toBe(true)
    expect(localStorage.getItem(makeStorageKey(p, 'queue'))).toBeNull()
  })

  it('entering cookieless purges the persisted event queue', async () => {
    vi.useFakeTimers()
    const p = 'proj-queue-cookieless'
    await bufferOneConsentedEvent(p)

    expect(setTrackingConsent('cookieless')).toBe(true)
    expect(storedKeys()).toEqual([])
  })

  // Withdrawal is forward-looking: events already collected under valid consent get one best-effort
  // send on the way out. What must not happen is them staying on the device.
  it('makes a final send attempt for events collected while consent was valid', async () => {
    vi.useFakeTimers()
    const p = 'proj-queue-flush'
    await bufferOneConsentedEvent(p)
    beacon.mockClear()
    sendBatch.mockClear()

    optOutTracking()

    const delivered = [...beacon.mock.calls, ...sendBatch.mock.calls].flatMap(
      call => (call as unknown as [unknown[]])[0] ?? [],
    )
    expect(delivered).toHaveLength(1)
    expect((delivered[0] as { kind: string }).kind).toBe('purchase')
  })

  // The leak had a second act: a later page load hydrated the surviving queue and beaconed it on
  // the first navigation, while getTrackingConsent() reported 'denied'.
  it('does not resurrect a queue on a later load that starts denied', async () => {
    vi.useFakeTimers()
    const p = 'proj-queue-reload'
    await bufferOneConsentedEvent(p)
    optOutTracking()
    // A failing beacon keeps destroy() from draining the queue itself — otherwise this passes
    // whether or not the purge ran, which is the same vacuity that hid the bug.
    beacon.mockReturnValue(false)
    destroy()
    beacon.mockReturnValue(true)
    beacon.mockClear()

    init(p, { apiKey: 'k', trackingConsent: { initial: 'denied', persist: true }, autoCapture: false })
    window.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(100)

    expect(beacon.mock.calls.flatMap(c => (c as unknown as [unknown[]])[0] ?? [])).toEqual([])
  })

  // R2-C1: the queue purge was folded into purgePersistedIdentity(), inheriting isAuthoritative() —
  // a gate whose reasoning is about *identity* (don't purge on a pre-banner seed, or you mint a new
  // identity every load / wipe a whole user base on deploy day). It does not transfer: the queue is
  // an outbound buffer, not an identifier anything reads back, so purging it can never mint one.
  //
  // `persist` defaults to false, so isAuthoritative() is false for the bare-string form the README's
  // CMP recipe produces — leaving a prior consented visit's queue on the device, to be beaconed on
  // the next pagehide while consent reads 'denied'.
  const leaveQueueOnDevice = async (p: string) => {
    await bufferOneConsentedEvent(p)
    // A failing beacon stops destroy() draining the queue itself, which would make this vacuous.
    beacon.mockReturnValue(false)
    destroy()
    beacon.mockReturnValue(true)
    beacon.mockClear()
    sendBatch.mockClear()
    expect(localStorage.getItem(makeStorageKey(p, 'queue'))).not.toBeNull()
  }

  it('purges a leftover queue on a bare-string denied init (consent not authoritative)', async () => {
    vi.useFakeTimers()
    const p = 'proj-leftover-denied'
    await leaveQueueOnDevice(p)

    init(p, { apiKey: 'k', trackingConsent: 'denied', autoCapture: false })

    expect(localStorage.getItem(makeStorageKey(p, 'queue'))).toBeNull()
  })

  // The leftover queue gets ONE best-effort send at init — purgeQueue()'s documented contract, and
  // the same forward-looking rule the transition path applies: withdrawal does not retroactively
  // make already-collected events unlawful to process, so dropping them unsent would lose data the
  // user had agreed to. What must not happen is the pre-fix behaviour: the queue surviving on the
  // device and being re-transmitted on every navigation, and again on every later visit.
  it('sends a leftover consented queue at most once, then never again', async () => {
    vi.useFakeTimers()
    const p = 'proj-leftover-transmit'
    await leaveQueueOnDevice(p)

    init(p, { apiKey: 'k', trackingConsent: 'denied', autoCapture: false })
    const afterInit = beacon.mock.calls.flatMap(c => (c as unknown as [unknown[]])[0] ?? []).length
    expect(afterInit).toBeGreaterThan(0) // the one lawful send happened
    expect(localStorage.getItem(makeStorageKey(p, 'queue'))).toBeNull()

    // Every subsequent navigation must carry nothing — pre-fix, each one re-sent the whole queue.
    beacon.mockClear()
    sendBatch.mockClear()
    window.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(100)

    expect(beacon.mock.calls.flatMap(c => (c as unknown as [unknown[]])[0] ?? [])).toEqual([])
    expect(sentEvents()).toEqual([])
  })

  it('writes nothing to the device when a leftover queue meets a cookieless init', async () => {
    vi.useFakeTimers()
    const p = 'proj-leftover-cookieless'
    // Several events, deliberately: a single leftover drains to empty and persist() calls
    // removeItem, so nothing is recorded and the assertion passes whether or not the bug is
    // present. A remainder after the first commit is what makes flush() re-persist identity-
    // bearing payloads (settle('commit') -> persist -> setItem) while consent reads 'cookieless'.
    sendBatch.mockRejectedValue(new RpcError('down', GrpcCode.Unavailable))
    init(p, { apiKey: 'k', trackingConsent: 'granted', autoCapture: false, batch: { maxWaitMs: 100 } })
    for (const amount of [1, 2, 3, 4, 5]) {
      track('purchase', { amount })
    }
    await vi.advanceTimersByTimeAsync(1500)
    expect(localStorage.getItem(makeStorageKey(p, 'queue'))).not.toBeNull()
    beacon.mockReturnValue(false)
    destroy()
    beacon.mockReturnValue(true)
    beacon.mockClear()

    // Sends succeed now, so the queue drains in batches — each commit leaving a remainder.
    sendBatch.mockResolvedValue({ accepted: 1 })
    const { writes } = recordDeviceWrites()
    init(p, { apiKey: 'k', trackingConsent: 'cookieless', autoCapture: false, batch: { maxSize: 2, maxWaitMs: 50 } })
    track('page_view')
    await vi.advanceTimersByTimeAsync(2000)

    expect(writes).toEqual([])
  })

  // R2-I4: rotate() and resetIdentity() are public API (barrel + CDN STUB_METHODS), so they are
  // reachable while cookieless or denied — where writing a fresh session or device id plants exactly
  // the identifier those states promise not to store. Both gates deleted cleanly with the suite
  // green: session.test.ts never passes the isGranted argument at all, and the tests that do reach
  // the real gate (through init(), here) never called reset() or rotate().
  it('reset() writes no identity to the device while cookieless', async () => {
    vi.useFakeTimers()
    init('proj-reset-ck', { apiKey: 'k', trackingConsent: 'cookieless', autoCapture: false })
    track('page_view')
    await vi.advanceTimersByTimeAsync(1000)

    const { writes } = recordDeviceWrites()
    reset()
    await vi.advanceTimersByTimeAsync(1000)

    expect(writes).toEqual([])
    expect(storedKeys()).toEqual([])
  })

  it('rotate() writes no session to the device while cookieless', async () => {
    vi.useFakeTimers()
    init('proj-rotate-ck', { apiKey: 'k', trackingConsent: 'cookieless', autoCapture: false })
    track('page_view')
    await vi.advanceTimersByTimeAsync(1000)

    const { writes } = recordDeviceWrites()
    rotate()
    await vi.advanceTimersByTimeAsync(1000)

    expect(writes).toEqual([])
    expect(storedKeys()).toEqual([])
  })

  it('rotate() does persist a new session under granted consent (control)', async () => {
    vi.useFakeTimers()
    init('proj-rotate-granted', { apiKey: 'k', trackingConsent: 'granted', autoCapture: false })
    track('page_view')
    await vi.advanceTimersByTimeAsync(1000)
    const before = localStorage.getItem(makeStorageKey('proj-rotate-granted', 'session'))

    rotate()

    const after = localStorage.getItem(makeStorageKey('proj-rotate-granted', 'session'))
    expect(after).not.toBeNull()
    expect(after).not.toBe(before)
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

describe('tab registry re-arm guard', () => {
  // armTabRegistry()'s `if (tabId) return` guard exists solely for a re-grant after a grant. G->G is
  // covered in pug.test.ts, but that file mocks ./session.js wholesale so it never reaches the real
  // function — deleting the guard left the whole suite green. This exercises the real module.
  it('does not add a second tab entry when consent is granted twice', async () => {
    vi.useFakeTimers()
    const p = 'proj-rearm'
    const tabsKey = makeStorageKey(p, 'tabs')

    init(p, { apiKey: 'k', trackingConsent: 'denied', autoCapture: false })
    optInTracking()
    expect(Object.keys(JSON.parse(localStorage.getItem(tabsKey) ?? '{}'))).toHaveLength(1)

    optInTracking() // granted -> granted: the guard's only purpose
    expect(Object.keys(JSON.parse(localStorage.getItem(tabsKey) ?? '{}'))).toHaveLength(1)
  })
})
