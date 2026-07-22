import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearProfile,
  configureProfile,
  getAnonymousId,
  isIdentified,
  markIdentified,
  resolveDistinctId,
} from './profile.js'
import { clearSession, configureSession, onConsentGranted, resetIdentity, resolveSessionId } from './session.js'
import { makeStorageKey } from './utils.js'

const logSpies = {
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

const setDebugLoggingSpy = vi.fn()

vi.mock('./logger.js', () => ({
  log: logSpies,
  setDebugLogging: setDebugLoggingSpy,
}))

const cleanupSpies = {
  pageView: vi.fn(),
  click: vi.fn(),
  scroll: vi.fn(),
  form: vi.fn(),
  rageClick: vi.fn(),
  deadClick: vi.fn(),
}

const transportSpies = {
  send: vi.fn(() => Promise.resolve()),
  destroy: vi.fn(),
  // Consent teardown drops the persisted event queue too. Omitting it here made every consent
  // transition in this file throw a swallowed TypeError and silently report failure.
  purgeQueue: vi.fn(() => true),
}

const unaryCallSpy = vi.fn(() => Promise.resolve({}))

const trackerSpies = {
  pageView: vi.fn(() => cleanupSpies.pageView),
  click: vi.fn(() => cleanupSpies.click),
  scroll: vi.fn(() => cleanupSpies.scroll),
  form: vi.fn(() => cleanupSpies.form),
  rageClick: vi.fn(() => cleanupSpies.rageClick),
  deadClick: vi.fn(() => cleanupSpies.deadClick),
}

vi.mock('./batch.js', () => ({
  createBatchedTransport: vi.fn(() => transportSpies),
}))

vi.mock('./rpc.js', () => ({
  unaryCall: unaryCallSpy,
  RpcError: class RpcError extends Error {},
  ONE_SHOT_TIMEOUT_MS: 15000,
}))

vi.mock('./events/page_view.js', () => ({
  setupPageViewTracking: trackerSpies.pageView,
}))

vi.mock('./events/click.js', () => ({
  setupClickTracking: trackerSpies.click,
}))

vi.mock('./events/scroll.js', () => ({
  setupScrollTracking: trackerSpies.scroll,
}))

vi.mock('./events/form.js', () => ({
  setupFormTracking: trackerSpies.form,
}))

vi.mock('./events/frustration.js', () => ({
  setupRageClickTracking: trackerSpies.rageClick,
  setupDeadClickTracking: trackerSpies.deadClick,
}))

// onConsentGranted was missing here while pug.ts imports and calls it. Vitest throws on access to an
// undefined mock export, and that call sits inside a try/catch that only warns — so every
// optInTracking() in this file threw, warned, and passed anyway. Ten tests were green while the
// grant-time side effect failed on every run. Same trap CLAUDE.md documents for setDebugLogging.
vi.mock('./session.js', () => ({
  clearSession: vi.fn(() => true),
  configureSession: vi.fn(),
  destroySession: vi.fn(),
  onConsentGranted: vi.fn(),
  resetIdentity: vi.fn(() => true),
  resolveSessionId: vi.fn(() => '01234567-0123-7123-8123-012345678901'),
}))

vi.mock('./profile.js', () => ({
  clearProfile: vi.fn(() => true),
  configureProfile: vi.fn(),
  destroyProfile: vi.fn(),
  getAnonymousId: vi.fn(() => 'anonymous-id'),
  isIdentified: vi.fn(() => false),
  markIdentified: vi.fn(),
  resolveDistinctId: vi.fn(() => 'distinct-id'),
}))

vi.mock('./parsers.js', () => ({
  initUserAgentData: vi.fn(),
  parseUserAgentData: vi.fn(() => ({})),
  parseUtmParams: vi.fn(() => ({})),
}))

const importPug = async () => import('./pug.js')

beforeEach(() => {
  vi.clearAllMocks()
  trackerSpies.pageView.mockImplementation(() => cleanupSpies.pageView)
  trackerSpies.click.mockImplementation(() => cleanupSpies.click)
  trackerSpies.scroll.mockImplementation(() => cleanupSpies.scroll)
  trackerSpies.form.mockImplementation(() => cleanupSpies.form)
  trackerSpies.rageClick.mockImplementation(() => cleanupSpies.rageClick)
  trackerSpies.deadClick.mockImplementation(() => cleanupSpies.deadClick)
  transportSpies.send.mockImplementation(() => Promise.resolve())
  unaryCallSpy.mockImplementation(() => Promise.resolve({}))
  vi.mocked(isIdentified).mockReturnValue(false)
  localStorage.clear()
})

afterEach(async () => {
  const { destroy } = await importPug()
  destroy()
})

describe('init debug logging', () => {
  it('leaves debug logging off by default', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })

    expect(setDebugLoggingSpy).toHaveBeenCalledWith(false)
  })

  it('enables debug logging when the debug option is set', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, debug: true })

    expect(setDebugLoggingSpy).toHaveBeenCalledWith(true)
  })

  it('turns debug logging back off on destroy', async () => {
    const { destroy, init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, debug: true })
    setDebugLoggingSpy.mockClear()
    destroy()

    expect(setDebugLoggingSpy).toHaveBeenCalledWith(false)
  })
})

describe('init autoCapture', () => {
  it('initializes all trackers by default', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key' })

    expect(trackerSpies.pageView).toHaveBeenCalledOnce()
    expect(trackerSpies.click).toHaveBeenCalledOnce()
    expect(trackerSpies.scroll).toHaveBeenCalledOnce()
    expect(trackerSpies.form).toHaveBeenCalledOnce()
    expect(trackerSpies.rageClick).toHaveBeenCalledOnce()
    expect(trackerSpies.deadClick).toHaveBeenCalledOnce()
  })

  it('supports selective tracker enablement', async () => {
    const { destroy, init } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: { pageView: true, click: true },
    })

    expect(trackerSpies.pageView).toHaveBeenCalledOnce()
    expect(trackerSpies.click).toHaveBeenCalledOnce()
    expect(trackerSpies.scroll).not.toHaveBeenCalled()
    expect(trackerSpies.form).not.toHaveBeenCalled()
    expect(trackerSpies.rageClick).not.toHaveBeenCalled()
    expect(trackerSpies.deadClick).not.toHaveBeenCalled()

    destroy()
    expect(cleanupSpies.pageView).toHaveBeenCalledOnce()
    expect(cleanupSpies.click).toHaveBeenCalledOnce()
    expect(cleanupSpies.scroll).not.toHaveBeenCalled()
    expect(cleanupSpies.form).not.toHaveBeenCalled()
    expect(cleanupSpies.rageClick).not.toHaveBeenCalled()
    expect(cleanupSpies.deadClick).not.toHaveBeenCalled()
  })

  it('treats omitted keys as disabled in object mode', async () => {
    const { init } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: { scroll: true },
    })

    expect(trackerSpies.pageView).not.toHaveBeenCalled()
    expect(trackerSpies.click).not.toHaveBeenCalled()
    expect(trackerSpies.scroll).toHaveBeenCalledOnce()
    expect(trackerSpies.form).not.toHaveBeenCalled()
    expect(trackerSpies.rageClick).not.toHaveBeenCalled()
    expect(trackerSpies.deadClick).not.toHaveBeenCalled()
  })

  it('disables all trackers when autoCapture is false', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })

    expect(trackerSpies.pageView).not.toHaveBeenCalled()
    expect(trackerSpies.click).not.toHaveBeenCalled()
    // `false` is the deliberate spelling of "capture nothing", so it must not draw the allowlist warning.
    expect(logSpies.warn).not.toHaveBeenCalledWith(expect.stringContaining('autoCapture is an allowlist'))
  })

  it('defaults to all trackers for invalid autoCapture shapes', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: 'yes' as never })

    expect(trackerSpies.pageView).toHaveBeenCalledOnce()
    expect(trackerSpies.click).toHaveBeenCalledOnce()
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('autoCapture must be a boolean or object'))
  })

  it('warns and ignores unknown and invalid autoCapture object values', async () => {
    const { init } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: { click: 'yes' as never, scroll: true, madeUp: true } as never,
    })

    expect(trackerSpies.click).not.toHaveBeenCalled()
    expect(trackerSpies.scroll).toHaveBeenCalledOnce()
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('Unknown autoCapture keys: madeUp'))
    expect(logSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('autoCapture values must be `true` for keys: click'),
    )
  })

  // The allowlist misread as a denylist: "everything except dead clicks" actually captures nothing.
  // AutoCaptureSelection types its values `true` so TS callers cannot write this, but JS callers and
  // the CDN's data-options JSON still can — and losing all capture must not be a silent debug line.
  it('warns that a selection enabling nothing disables all capture', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: { deadClick: false } as never })

    expect(trackerSpies.pageView).not.toHaveBeenCalled()
    expect(trackerSpies.click).not.toHaveBeenCalled()
    expect(trackerSpies.deadClick).not.toHaveBeenCalled()
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('autoCapture is an allowlist'))
  })

  it('does not warn about the allowlist for a selection that only enables', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: { scroll: true } })

    expect(logSpies.warn).not.toHaveBeenCalledWith(expect.stringContaining('autoCapture is an allowlist'))
  })

  // The quieter half of the denylist misread: this one still enables something, so a check keyed on
  // "enables nothing" stays silent while click, form, rageClick and deadClick are all lost.
  it('warns about the allowlist when a selection mixes `true` with an explicit `false`', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: { pageView: true, scroll: false } as never })

    expect(trackerSpies.pageView).toHaveBeenCalledOnce()
    expect(trackerSpies.click).not.toHaveBeenCalled()
    expect(trackerSpies.deadClick).not.toHaveBeenCalled()
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('autoCapture is an allowlist'))
    // The message must name what survived, since that is what reveals the loss.
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('This selection enables pageView.'))
  })

  // Validation lives in setDesired, not reconcile, so consent-first integrations hear about a bad
  // selection at init() rather than whenever the user eventually opts in.
  it('validates the selection at init even while tracking consent is denied', async () => {
    const { init } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      trackingConsent: 'denied',
      autoCapture: { deadClick: false } as never,
    })

    expect(trackerSpies.deadClick).not.toHaveBeenCalled()
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('autoCapture is an allowlist'))
  })

  it('logs an aggregate error when tracker setup fails', async () => {
    trackerSpies.click.mockImplementation(() => {
      throw new Error('boom')
    })
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: { click: true, scroll: true } })

    expect(trackerSpies.scroll).toHaveBeenCalledOnce()
    expect(logSpies.error).toHaveBeenCalledWith('1/2 trackers failed to initialize.')
  })
})

describe('runtime autoCapture', () => {
  it('enables and disables trackers after init', async () => {
    const { init, setAutoCapture } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })
    setAutoCapture({ click: true, form: true })

    expect(trackerSpies.click).toHaveBeenCalledOnce()
    expect(trackerSpies.form).toHaveBeenCalledOnce()

    setAutoCapture({ form: true })

    expect(cleanupSpies.click).toHaveBeenCalledOnce()
    expect(cleanupSpies.form).not.toHaveBeenCalled()
  })

  it('warns when setAutoCapture is called before init', async () => {
    const { setAutoCapture } = await importPug()

    setAutoCapture({ click: true })

    expect(trackerSpies.click).not.toHaveBeenCalled()
    expect(logSpies.warn).toHaveBeenCalledWith('setAutoCapture() called before init().')
  })

  it('cleans up runtime-enabled trackers on destroy', async () => {
    const { destroy, init, setAutoCapture } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })
    setAutoCapture({ click: true, form: true })
    destroy()

    expect(cleanupSpies.click).toHaveBeenCalledOnce()
    expect(cleanupSpies.form).toHaveBeenCalledOnce()
  })

  it('does not tear down a tracker that stays enabled across setAutoCapture calls', async () => {
    const { init, setAutoCapture } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: { click: true } })
    expect(trackerSpies.click).toHaveBeenCalledOnce()

    setAutoCapture({ click: true, form: true })

    expect(trackerSpies.click).toHaveBeenCalledOnce()
    expect(cleanupSpies.click).not.toHaveBeenCalled()
    expect(trackerSpies.form).toHaveBeenCalledOnce()
  })
})

describe('tracking consent', () => {
  it('starts opted in by default', async () => {
    const { init, isTrackingEnabled } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })

    expect(isTrackingEnabled()).toBe(true)
  })

  it('can start opted out by default', async () => {
    const { getTrackingConsent, init, isTrackingEnabled } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, trackingConsent: 'denied' })

    expect(isTrackingEnabled()).toBe(false)
    expect(getTrackingConsent()).toBe('denied')
  })

  it('does not attach auto-capture listeners while opted out', async () => {
    const { init } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      trackingConsent: 'denied',
      autoCapture: { pageView: true, click: true },
    })

    expect(trackerSpies.pageView).not.toHaveBeenCalled()
    expect(trackerSpies.click).not.toHaveBeenCalled()
  })

  it('defers setAutoCapture until opt in while opted out', async () => {
    const { init, optInTracking, setAutoCapture } = await importPug()

    init('project-id', { apiKey: 'api-key', trackingConsent: 'denied', autoCapture: false })
    setAutoCapture({ click: true })

    expect(trackerSpies.click).not.toHaveBeenCalled()
    expect(logSpies.debug).toHaveBeenCalledWith('setAutoCapture() stored selection; listeners activate after opt-in.')

    optInTracking()

    expect(trackerSpies.click).toHaveBeenCalledOnce()
  })

  it('drops manual track calls while opted out', async () => {
    const { init, track } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, trackingConsent: 'denied' })
    track('signup', { plan: 'pro' })

    expect(transportSpies.send).not.toHaveBeenCalled()
  })

  it('resumes manual track calls after opt in', async () => {
    const { init, optInTracking, track } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, trackingConsent: 'denied' })
    optInTracking()
    track('signup', { plan: 'pro' })

    expect(transportSpies.send).toHaveBeenCalledOnce()
  })

  it('drops identify calls while opted out', async () => {
    const { identify, init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, trackingConsent: 'denied' })

    await expect(identify('user-1')).resolves.toBeUndefined()
    expect(unaryCallSpy).not.toHaveBeenCalled()
    expect(markIdentified).not.toHaveBeenCalled()
  })

  it('runtime opt out blocks later track calls', async () => {
    const { init, optOutTracking, track } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })
    optOutTracking()
    track('signup', { plan: 'pro' })

    expect(transportSpies.send).not.toHaveBeenCalled()
  })

  it('opt out tears down active auto-capture listeners', async () => {
    const { init, optOutTracking, setAutoCapture } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: { click: true } })
    setAutoCapture({ click: true, form: true })
    optOutTracking()

    expect(cleanupSpies.click).toHaveBeenCalledOnce()
    expect(cleanupSpies.form).toHaveBeenCalledOnce()
  })

  it('opt out tears down persisted identity (profile and session)', async () => {
    const { init, optOutTracking } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })
    optOutTracking()

    expect(clearProfile).toHaveBeenCalledOnce()
    expect(clearSession).toHaveBeenCalledOnce()
  })

  it('opt in restores the stored auto-capture selection', async () => {
    const { init, optInTracking } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      trackingConsent: 'denied',
      autoCapture: { scroll: true, form: true },
    })
    optInTracking()

    expect(trackerSpies.scroll).toHaveBeenCalledOnce()
    expect(trackerSpies.form).toHaveBeenCalledOnce()
    expect(trackerSpies.click).not.toHaveBeenCalled()
  })

  it('warns when consent helpers are called before init', async () => {
    const { getTrackingConsent, isTrackingEnabled } = await importPug()

    expect(isTrackingEnabled()).toBe(false)
    expect(getTrackingConsent()).toBeUndefined()
    expect(logSpies.warn).toHaveBeenCalledWith('isTrackingEnabled() called before init().')
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('getTrackingConsent() called before init()'))
  })

  // Regression: getTrackingConsent() used to answer 'denied' before init(), which is indistinguishable
  // from a real opt-out. A consent banner gated on it would re-prompt a user who had already opted in,
  // because the persisted choice is not read from storage until init() runs.
  it('reports undefined — not denied — before init even when a granted choice is persisted', async () => {
    localStorage.setItem(makeStorageKey('project-id', 'consent'), 'granted')
    const { getTrackingConsent, init } = await importPug()

    expect(getTrackingConsent()).toBeUndefined()

    init('project-id', { apiKey: 'api-key', autoCapture: false, trackingConsent: { initial: 'denied', persist: true } })

    expect(getTrackingConsent()).toBe('granted')
  })

  it('reports consent pending until the user answers, and not after', async () => {
    const { init, isConsentPending, getTrackingConsent, optInTracking } = await importPug()

    // Before init: true, because a persisted choice has not been read yet.
    expect(isConsentPending()).toBe(true)
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('isConsentPending() called before init()'))

    init('project-id', { apiKey: 'api-key', autoCapture: false })
    // Seeded 'granted' — the SDK is tracking, but the user has not chosen it.
    expect(getTrackingConsent()).toBe('granted')
    expect(isConsentPending()).toBe(true)

    optInTracking()
    expect(isConsentPending()).toBe(false)
  })

  it('reports consent decided when a persisted choice is restored', async () => {
    localStorage.setItem(makeStorageKey('project-id', 'consent'), 'cookieless')
    const { init, isConsentPending } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      trackingConsent: { initial: 'granted', persist: true },
    })

    expect(isConsentPending()).toBe(false)
  })

  it('optOutTracking applies onReject: cookieless instead of denied', async () => {
    const { init, isTrackingEnabled, getTrackingConsent, optOutTracking } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      trackingConsent: { initial: 'cookieless', onReject: 'cookieless' },
    })

    expect(optOutTracking()).toBe(true)
    expect(getTrackingConsent()).toBe('cookieless')
    // The point of the mode: rejecting keeps identity-free traffic counts flowing.
    expect(isTrackingEnabled()).toBe(true)
    // And still tears identity down, exactly as a denied rejection would.
    expect(clearProfile).toHaveBeenCalled()
    expect(clearSession).toHaveBeenCalled()
  })

  it('optOutTracking still denies by default', async () => {
    const { init, isTrackingEnabled, getTrackingConsent, optOutTracking } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })
    optOutTracking()

    expect(getTrackingConsent()).toBe('denied')
    expect(isTrackingEnabled()).toBe(false)
  })

  it('warns and reports failure when optOutTracking runs before init', async () => {
    const { optOutTracking } = await importPug()

    expect(optOutTracking()).toBe(false)
    expect(logSpies.warn).toHaveBeenCalledWith('optOutTracking() called before init().')
  })

  // The accept half of the same banner: it delegated, so the warning named setTrackingConsent.
  it('warns and reports failure when optInTracking runs before init', async () => {
    const { optInTracking } = await importPug()

    expect(optInTracking()).toBe(false)
    expect(logSpies.warn).toHaveBeenCalledWith('optInTracking() called before init().')
  })

  it('reports granted consent after opt in', async () => {
    const { getTrackingConsent, init, isTrackingEnabled, optInTracking } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, trackingConsent: 'denied' })
    expect(isTrackingEnabled()).toBe(false)

    optInTracking()

    expect(isTrackingEnabled()).toBe(true)
    expect(getTrackingConsent()).toBe('granted')
  })

  it('warns once at init when consent is denied', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, trackingConsent: 'denied' })

    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('Tracking consent is denied'))
  })

  it('restores the same selection across an opt-out / opt-in cycle', async () => {
    const { init, optInTracking, optOutTracking } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: { scroll: true, form: true } })
    expect(trackerSpies.scroll).toHaveBeenCalledOnce()
    expect(trackerSpies.form).toHaveBeenCalledOnce()

    optOutTracking()
    expect(cleanupSpies.scroll).toHaveBeenCalledOnce()
    expect(cleanupSpies.form).toHaveBeenCalledOnce()

    optInTracking()
    expect(trackerSpies.scroll).toHaveBeenCalledTimes(2)
    expect(trackerSpies.form).toHaveBeenCalledTimes(2)
    expect(trackerSpies.click).not.toHaveBeenCalled()
  })

  it('is idempotent across repeated opt-in calls', async () => {
    const { init, optInTracking } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: { click: true } })
    optInTracking()
    optInTracking()

    expect(trackerSpies.click).toHaveBeenCalledOnce()
    expect(cleanupSpies.click).not.toHaveBeenCalled()
  })

  it('does not double-invoke cleanups when destroy follows opt out', async () => {
    const { destroy, init, optOutTracking } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: { click: true } })
    optOutTracking()
    expect(cleanupSpies.click).toHaveBeenCalledOnce()

    destroy()
    expect(cleanupSpies.click).toHaveBeenCalledOnce()
  })
})

describe('identify', () => {
  it('sends identify and marks identified after opt in', async () => {
    vi.mocked(isIdentified).mockReturnValue(true)
    const { identify, init, optInTracking } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, trackingConsent: 'denied' })
    optInTracking()
    await identify('user-1')

    expect(unaryCallSpy).toHaveBeenCalledOnce()
    expect(markIdentified).toHaveBeenCalledWith('user-1')
  })

  it('uses a longer-than-default timeout for the one-shot identify RPC', async () => {
    vi.mocked(isIdentified).mockReturnValue(true)
    const { identify, init, optInTracking } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, trackingConsent: 'denied' })
    optInTracking()
    await identify('user-1')

    // identify is a one-shot with no retry, so aborting a cold backend at the 5s batch default
    // would permanently lose the call. It gets an explicit longer timeout instead.
    const timeoutArg = unaryCallSpy.mock.calls[0][4]
    expect(timeoutArg).toBeGreaterThan(5000)
  })

  it('does not throw on an invalid externalId', async () => {
    const { identify, init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })

    await expect(identify('')).resolves.toBeUndefined()
    expect(unaryCallSpy).not.toHaveBeenCalled()
    expect(logSpies.error).toHaveBeenCalledWith(expect.stringContaining('non-empty externalId'))
  })

  it('swallows RPC failures without throwing', async () => {
    vi.mocked(isIdentified).mockReturnValue(true)
    unaryCallSpy.mockImplementationOnce(() => Promise.reject(new Error('rpc down')))
    const { identify, init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })

    await expect(identify('user-1')).resolves.toBeUndefined()
    expect(logSpies.error).toHaveBeenCalledWith('Failed to identify:', expect.any(Error))
    expect(markIdentified).not.toHaveBeenCalled()
  })

  it('does not leak the externalId (PII) into logs when identify throws unexpectedly', async () => {
    const PII = 'user@example.com'
    // Force the outer catch: getAnonymousId (called while building the request on first identify)
    // throws. The catch must log the failure WITHOUT interpolating the externalId, which is
    // frequently PII (email, account id).
    vi.mocked(isIdentified).mockReturnValue(false)
    vi.mocked(getAnonymousId).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const { identify, init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })
    await expect(identify(PII)).resolves.toBeUndefined()

    expect(logSpies.error).toHaveBeenCalledWith('Unexpected error in identify():', expect.any(Error))
    // The redaction guarantee: no error log (message or args) contains the PII externalId.
    for (const call of logSpies.error.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(PII)
    }
  })
})

describe('tracking consent persistence', () => {
  const CONSENT_KEY = makeStorageKey('project-id', 'consent')

  it('persists consent across a destroy / re-init cycle', async () => {
    const { destroy, getTrackingConsent, init, optOutTracking } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      trackingConsent: { initial: 'granted', persist: true },
    })
    optOutTracking()
    expect(localStorage.getItem(CONSENT_KEY)).toBe('denied')

    destroy()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      trackingConsent: { initial: 'granted', persist: true },
    })
    expect(getTrackingConsent()).toBe('denied')
  })

  it('restores granted over a denied default after opt-in and re-init', async () => {
    const { destroy, getTrackingConsent, init, optInTracking } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      trackingConsent: { initial: 'denied', persist: true },
    })
    optInTracking()
    expect(localStorage.getItem(CONSENT_KEY)).toBe('granted')

    destroy()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      trackingConsent: { initial: 'denied', persist: true },
    })
    expect(getTrackingConsent()).toBe('granted')
  })

  it('does not persist consent when persist is not set', async () => {
    const { init, optOutTracking } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, trackingConsent: 'granted' })
    optOutTracking()

    expect(localStorage.getItem(CONSENT_KEY)).toBeNull()
  })

  it('reset does not clear persisted consent', async () => {
    const { init, optOutTracking, reset } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      trackingConsent: { initial: 'granted', persist: true },
    })
    optOutTracking()
    expect(localStorage.getItem(CONSENT_KEY)).toBe('denied')

    reset()

    expect(localStorage.getItem(CONSENT_KEY)).toBe('denied')
  })
})

describe('beforeSend wiring', () => {
  type SentEvent = {
    autoProperties: Record<string, { value: { value: unknown } }>
    customProperties: Record<string, { value: { value: unknown } }>
  }

  it('applies init({ beforeSend }) to outgoing events', async () => {
    const { init, track } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      beforeSend: e => {
        delete e.customProperties.ssn
        return e
      },
    })
    track('signup', { ssn: '123-45-6789', plan: 'pro' })

    const event = transportSpies.send.mock.calls[0][0] as SentEvent
    expect(event.customProperties.ssn).toBeUndefined()
    expect(event.customProperties.plan.value.value).toBe('pro')
  })

  it('can mask $url, the job sanitizeUrl used to do', async () => {
    const { init, track } = await importPug()
    type SentEvent = { autoProperties: Record<string, { value: { value: unknown } }> }

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      beforeSend: e => {
        e.autoProperties.$url = 'REDACTED'
        return e
      },
    })
    track('signup')

    const event = transportSpies.send.mock.calls[0][0] as SentEvent
    expect(event.autoProperties.$url.value.value).toBe('REDACTED')
  })

  // A dropped event must not reach the transport at all — not queued, not beaconed later.
  it('never hands a dropped event to the transport', async () => {
    const { init, track } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, beforeSend: () => null })
    track('signup')

    expect(transportSpies.send).not.toHaveBeenCalled()
  })

  // A JS or one-tag install gets no compile error for the removed option, so without this the
  // migration is silent and URLs the integrator believes are masked start going out raw.
  it('warns when the removed sanitizeUrl option is still passed', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, sanitizeUrl: () => 'x' } as never)

    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('sanitizeUrl was removed'))
  })

  it('stops applying the hook after a destroy / re-init without one', async () => {
    const { destroy, init, track } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, beforeSend: () => null })
    destroy()
    init('project-id', { apiKey: 'api-key', autoCapture: false })
    track('signup')

    expect(transportSpies.send).toHaveBeenCalledOnce()
  })
})

describe('crossSubdomainTracking wiring', () => {
  const CONSENT_KEY = makeStorageKey('project-id', 'consent')

  const capturedStore = () => {
    const store = vi.mocked(configureSession).mock.calls[0]?.[2]
    if (!store) {
      throw new Error('configureSession did not receive a persistent store')
    }
    return store
  }

  it('defaults to off (localStorage-only) and threads the same store into session and profile', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })

    const store = capturedStore()
    expect(vi.mocked(configureProfile)).toHaveBeenCalledWith('project-id', store, expect.any(Function))
    // The default is now off (per the threat model — cross-subdomain must be an explicit opt-in):
    // no cookie layer, so writes go to localStorage only, never document.cookie.
    store.setItem('__pug_wiring_probe__', 'v')
    expect(document.cookie).not.toContain('__pug_wiring_probe__')
    expect(localStorage.getItem('__pug_wiring_probe__')).toBe('v')
    expect(store.crossSubdomain).toBe(false)
  })

  it('threads the store into consent so a persisted opt-out rides the cookie when enabled', async () => {
    const { init, optOutTracking } = await importPug()

    // Cross-subdomain must be explicitly enabled for consent to ride the cookie (default is off).
    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      crossSubdomainTracking: true,
      trackingConsent: { persist: true },
    })
    optOutTracking()

    expect(document.cookie).toContain(`${CONSENT_KEY}=denied`)
  })

  it('crossSubdomainTracking: false builds a store without a cookie layer', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, crossSubdomainTracking: false })

    const store = capturedStore()
    store.setItem('__pug_wiring_probe__', 'v')
    expect(document.cookie).not.toContain('__pug_wiring_probe__')
    expect(localStorage.getItem('__pug_wiring_probe__')).toBe('v')
  })

  it('passes an explicit { domain } through to the cookie layer', async () => {
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, crossSubdomainTracking: { domain: 'example.com' } })

    // localhost is not covered by example.com — the layer warns and falls back to host-only,
    // proving the option reached the cookie layer intact.
    expect(logSpies.warn).toHaveBeenCalledWith(
      'crossSubdomainTracking domain "example.com" is not usable on "localhost"; using a host-only cookie instead.',
    )
  })
})

describe('cookieless mode', () => {
  it('track() sends identity-free flagged events and never touches session/profile', async () => {
    const { init, track } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'cookieless' })
    track('page_view')
    const [event] = transportSpies.send.mock.calls.at(-1) ?? []
    expect(event.cookieless).toBe(true)
    expect(event.distinctId).toBe('')
    expect(event.sessionId).toBe('')
    expect(vi.mocked(resolveSessionId)).not.toHaveBeenCalled()
    expect(vi.mocked(resolveDistinctId)).not.toHaveBeenCalled()
  })

  it('auto-capture listeners run in cookieless mode', async () => {
    const { init } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'cookieless', autoCapture: true })
    expect(trackerSpies.pageView).toHaveBeenCalled()
  })

  // Warn, not debug: isTrackingEnabled() returns true in cookieless mode, so the pre-flight check
  // integrators were told to use takes the branch and identifies nobody. A debug-gated message is
  // invisible to precisely the person debugging that.
  it('identify() warns once and drops in cookieless mode', async () => {
    const { init, identify } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'cookieless' })
    await identify('user@example.com')
    await identify('another@example.com')
    expect(unaryCallSpy).not.toHaveBeenCalled()
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('cookieless mode'))
    expect(logSpies.warn.mock.calls.filter(c => String(c[0]).includes('cookieless mode'))).toHaveLength(1)
  })

  it('identify() drops at debug level when consent is denied', async () => {
    const { init, identify } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'denied' })
    await identify('user@example.com')
    expect(unaryCallSpy).not.toHaveBeenCalled()
    expect(logSpies.debug).toHaveBeenCalledWith(expect.stringContaining('denied'))
  })

  // The server reserves this prefix for cookieless identities and rejects the ENTIRE batch
  // containing an offending distinct_id, so one bad identify() poisons every later batch for
  // that user with no signal pointing back at the cause.
  it('identify() rejects an externalId using the reserved cookieless- prefix', async () => {
    const { init, identify } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'granted' })
    await identify('cookieless-42')
    expect(unaryCallSpy).not.toHaveBeenCalled()
    expect(logSpies.error).toHaveBeenCalledWith(expect.stringContaining('reserved'))
  })

  it('setTrackingConsent granted->cookieless purges identity; ->granted mints nothing eagerly', async () => {
    const { init, setTrackingConsent } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'granted' })
    setTrackingConsent('cookieless')
    expect(vi.mocked(clearProfile)).toHaveBeenCalled()
    expect(vi.mocked(clearSession)).toHaveBeenCalled()
    setTrackingConsent('granted')
    // Fresh identity is lazy — nothing resolves until the next event.
    expect(vi.mocked(resolveDistinctId)).not.toHaveBeenCalled()
  })

  it('isTrackingEnabled() is true in cookieless mode; getTrackingConsent() reports it', async () => {
    const { init, isTrackingEnabled, getTrackingConsent } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'cookieless' })
    expect(isTrackingEnabled()).toBe(true)
    expect(getTrackingConsent()).toBe('cookieless')
  })

  it('denied -> cookieless starts listeners (reconcile turns capture on)', async () => {
    const { init, setTrackingConsent } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'denied', autoCapture: true })
    expect(trackerSpies.pageView).not.toHaveBeenCalled()
    setTrackingConsent('cookieless')
    expect(trackerSpies.pageView).toHaveBeenCalled()
  })
})

describe('respectGpc wiring', () => {
  const withGpc = (value: unknown): void => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value, configurable: true })
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'globalPrivacyControl')
  })

  it('starts denied with no listeners attached and drops track()', async () => {
    withGpc(true)
    const { init, track, getTrackingConsent, isTrackingEnabled } = await importPug()

    init('proj', { apiKey: 'k', autoCapture: true, trackingConsent: { respectGpc: true } })

    expect(getTrackingConsent()).toBe('denied')
    expect(isTrackingEnabled()).toBe(false)
    expect(trackerSpies.pageView).not.toHaveBeenCalled()
    track('click')
    expect(transportSpies.send).not.toHaveBeenCalled()
  })

  // isAuthoritative() is what gates this, so a GPC user does not keep a prior consented visit's ids.
  it('purges identity left over from an earlier consented visit', async () => {
    withGpc(true)
    const { init } = await importPug()

    init('proj', { apiKey: 'k', autoCapture: false, trackingConsent: { respectGpc: true } })

    expect(clearProfile).toHaveBeenCalled()
    expect(clearSession).toHaveBeenCalled()
    expect(transportSpies.purgeQueue).toHaveBeenCalled()
  })

  it('keeps events flowing identity-free when onReject is cookieless', async () => {
    withGpc(true)
    const { init, track, getTrackingConsent } = await importPug()

    init('proj', { apiKey: 'k', autoCapture: false, trackingConsent: { respectGpc: true, onReject: 'cookieless' } })

    expect(getTrackingConsent()).toBe('cookieless')
    track('click')
    expect(transportSpies.send).toHaveBeenCalled()
    expect(resolveSessionId).not.toHaveBeenCalled()
  })

  it('does not override a stored opt-in from this site', async () => {
    withGpc(true)
    localStorage.setItem(makeStorageKey('proj', 'consent'), 'granted')
    const { init, getTrackingConsent } = await importPug()

    init('proj', { apiKey: 'k', autoCapture: false, trackingConsent: { respectGpc: true, persist: true } })

    expect(getTrackingConsent()).toBe('granted')
  })
})

describe('consent teardown contract', () => {
  it('purges the persisted event queue when leaving granted', async () => {
    const { init, optOutTracking } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'granted' })
    transportSpies.purgeQueue.mockClear()

    expect(optOutTracking()).toBe(true)
    expect(transportSpies.purgeQueue).toHaveBeenCalled()
  })

  // The boolean exists so a withdrawal that did not fully land is detectable rather than
  // console-only. Nothing asserted it, so a teardown that reported failure looked identical.
  it('reports false when a queued-event purge does not land', async () => {
    const { init, optOutTracking } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'granted' })
    transportSpies.purgeQueue.mockReturnValueOnce(false)

    expect(optOutTracking()).toBe(false)
  })

  it('reset() reports whether the identity teardown landed', async () => {
    const { init, reset } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'granted' })
    vi.mocked(clearProfile).mockReturnValueOnce(false)

    // reset() is the logout path — the one place an integrator most needs to know a cross-subdomain
    // identity cookie survived, since the next user of that browser inherits it.
    expect(reset()).toBe(false)
  })

  // C->D was the one transition where isTracking() goes true->false FROM cookieless, so listeners
  // must tear down. It shared code with G->D, but nothing exercised it.
  it('cookieless -> denied tears listeners down', async () => {
    const { init, setTrackingConsent } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'cookieless', autoCapture: true })
    expect(trackerSpies.pageView).toHaveBeenCalled()

    expect(setTrackingConsent('denied')).toBe(true)
    expect(cleanupSpies.pageView).toHaveBeenCalled()
  })

  it('denied -> denied is idempotent and still reports success', async () => {
    const { init, optOutTracking } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'denied', autoCapture: true })

    expect(optOutTracking()).toBe(true)
    expect(optOutTracking()).toBe(true)
    expect(trackerSpies.pageView).not.toHaveBeenCalled()
  })

  // The grant-time side effect itself, asserted rather than assumed: the mock omission above meant
  // this call threw into a warn-only catch on every opt-in while ten tests stayed green.
  it('re-arms the tab registry when consent is granted', async () => {
    const { init, optInTracking } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'denied' })
    vi.mocked(onConsentGranted).mockClear()

    expect(optInTracking()).toBe(true)
    expect(onConsentGranted).toHaveBeenCalled()
  })

  it('does not re-arm the tab registry when entering a non-granted state', async () => {
    const { init, setTrackingConsent } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'granted' })
    vi.mocked(onConsentGranted).mockClear()

    setTrackingConsent('cookieless')
    expect(onConsentGranted).not.toHaveBeenCalled()
  })
})

describe('teardown failures surface in the returned boolean', () => {
  // These booleans exist so a withdrawal that did not fully land is detectable rather than
  // console-only — but every teardown leg was mocked as vi.fn(() => true), so the failure arm was
  // unreachable and forcing any of them to always-true left the suite green.
  it('reports false when the profile could not be cleared', async () => {
    const { init, optOutTracking } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'granted' })
    vi.mocked(clearProfile).mockReturnValueOnce(false)

    expect(optOutTracking()).toBe(false)
  })

  it('reports false when the session could not be cleared', async () => {
    const { init, optOutTracking } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'granted' })
    vi.mocked(clearSession).mockReturnValueOnce(false)

    expect(optOutTracking()).toBe(false)
  })

  it('reports false when the queued events could not be purged', async () => {
    const { init, optOutTracking } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'granted' })
    transportSpies.purgeQueue.mockReturnValueOnce(false)

    expect(optOutTracking()).toBe(false)
  })

  // resetIdentity() logs an error and returns on a failed persist — it never throws — so reset()'s
  // try/catch could not see it and returned true while the previous user's session and device id
  // were still on the device. That is verbatim the case README promises the boolean covers.
  it('reset() reports false when the identity could not be reset', async () => {
    const { init, reset } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'granted' })
    vi.mocked(resetIdentity).mockReturnValueOnce(false)

    expect(reset()).toBe(false)
  })

  it('reset() reports true when every leg succeeds', async () => {
    const { init, reset } = await importPug()
    init('proj', { apiKey: 'k', trackingConsent: 'granted' })

    expect(reset()).toBe(true)
  })
})
