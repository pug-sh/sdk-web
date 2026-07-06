import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearProfile, configureProfile, getAnonymousId, isIdentified, markIdentified } from './profile.js'
import { clearSession, configureSession } from './session.js'
import { makeStorageKey } from './utils.js'

const logSpies = {
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

vi.mock('./logger.js', () => ({
  log: logSpies,
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
}

const profilesClientSpies = {
  identify: vi.fn(() => Promise.resolve({})),
}

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

vi.mock('@connectrpc/connect', () => ({
  createClient: vi.fn(() => profilesClientSpies),
}))

vi.mock('./api-transport.js', () => ({
  createApiTransport: vi.fn(() => ({})),
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

vi.mock('./session.js', () => ({
  clearSession: vi.fn(),
  configureSession: vi.fn(),
  destroySession: vi.fn(),
  resetIdentity: vi.fn(),
  resolveSessionId: vi.fn(() => '01234567-0123-7123-8123-012345678901'),
}))

vi.mock('./profile.js', () => ({
  clearProfile: vi.fn(),
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
  profilesClientSpies.identify.mockImplementation(() => Promise.resolve({}))
  vi.mocked(isIdentified).mockReturnValue(false)
  localStorage.clear()
})

afterEach(async () => {
  const { destroy } = await importPug()
  destroy()
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
      autoCapture: { pageView: true, click: true, scroll: false },
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
      expect.stringContaining('autoCapture values must be boolean for keys: click'),
    )
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
    expect(profilesClientSpies.identify).not.toHaveBeenCalled()
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
    expect(getTrackingConsent()).toBe('denied')
    expect(logSpies.warn).toHaveBeenCalledWith('isTrackingEnabled() called before init().')
    expect(logSpies.warn).toHaveBeenCalledWith('getTrackingConsent() called before init().')
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

    expect(profilesClientSpies.identify).toHaveBeenCalledOnce()
    expect(markIdentified).toHaveBeenCalledWith('user-1')
  })

  it('does not throw on an invalid externalId', async () => {
    const { identify, init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })

    await expect(identify('')).resolves.toBeUndefined()
    expect(profilesClientSpies.identify).not.toHaveBeenCalled()
    expect(logSpies.error).toHaveBeenCalledWith(expect.stringContaining('non-empty externalId'))
  })

  it('swallows RPC failures without throwing', async () => {
    vi.mocked(isIdentified).mockReturnValue(true)
    profilesClientSpies.identify.mockImplementationOnce(() => Promise.reject(new Error('rpc down')))
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
      trackingConsent: { default: 'granted', persist: true },
    })
    optOutTracking()
    expect(localStorage.getItem(CONSENT_KEY)).toBe('denied')

    destroy()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      trackingConsent: { default: 'granted', persist: true },
    })
    expect(getTrackingConsent()).toBe('denied')
  })

  it('restores granted over a denied default after opt-in and re-init', async () => {
    const { destroy, getTrackingConsent, init, optInTracking } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      trackingConsent: { default: 'denied', persist: true },
    })
    optInTracking()
    expect(localStorage.getItem(CONSENT_KEY)).toBe('granted')

    destroy()

    init('project-id', {
      apiKey: 'api-key',
      autoCapture: false,
      trackingConsent: { default: 'denied', persist: true },
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
      trackingConsent: { default: 'granted', persist: true },
    })
    optOutTracking()
    expect(localStorage.getItem(CONSENT_KEY)).toBe('denied')

    reset()

    expect(localStorage.getItem(CONSENT_KEY)).toBe('denied')
  })
})

describe('url sanitizer wiring', () => {
  type SentEvent = { autoProperties: Record<string, { value: { value: unknown } }> }

  it('applies init({ sanitizeUrl }) to outgoing event URLs', async () => {
    const { init, track } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, sanitizeUrl: () => 'REDACTED' })
    track('signup', { plan: 'pro' })

    expect(transportSpies.send).toHaveBeenCalledOnce()
    const event = transportSpies.send.mock.calls[0][0] as SentEvent
    expect(event.autoProperties.$url.value.value).toBe('REDACTED')
  })

  it('sends raw URLs after a destroy / re-init without a sanitizer', async () => {
    const { destroy, init, track } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, sanitizeUrl: () => 'REDACTED' })
    destroy()
    init('project-id', { apiKey: 'api-key', autoCapture: false })
    track('signup', { plan: 'pro' })

    const event = transportSpies.send.mock.calls.at(-1)?.[0] as SentEvent
    expect(event.autoProperties.$url.value.value).not.toBe('REDACTED')
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
