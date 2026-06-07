import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('logs an aggregate warning when tracker setup fails', async () => {
    trackerSpies.click.mockImplementation(() => {
      throw new Error('boom')
    })
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: { click: true, scroll: true } })

    expect(trackerSpies.scroll).toHaveBeenCalledOnce()
    expect(logSpies.warn).toHaveBeenCalledWith('1/2 trackers failed to initialize.')
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
})

describe('tracking consent', () => {
  it('starts opted in by default', async () => {
    const { init, isTrackingEnabled } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false })

    expect(isTrackingEnabled()).toBe(true)
  })

  it('can start opted out by default', async () => {
    const { getTrackingConsent, init, isTrackingEnabled } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, defaultTrackingConsent: 'denied' })

    expect(isTrackingEnabled()).toBe(false)
    expect(getTrackingConsent()).toBe('denied')
  })

  it('does not attach auto-capture listeners while opted out', async () => {
    const { init } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      defaultTrackingConsent: 'denied',
      autoCapture: { pageView: true, click: true },
    })

    expect(trackerSpies.pageView).not.toHaveBeenCalled()
    expect(trackerSpies.click).not.toHaveBeenCalled()
  })

  it('defers setAutoCapture until opt in while opted out', async () => {
    const { init, optInTracking, setAutoCapture } = await importPug()

    init('project-id', { apiKey: 'api-key', defaultTrackingConsent: 'denied', autoCapture: false })
    setAutoCapture({ click: true })

    expect(trackerSpies.click).not.toHaveBeenCalled()
    expect(logSpies.debug).toHaveBeenCalledWith('setAutoCapture() stored selection; listeners activate after opt-in.')

    optInTracking()

    expect(trackerSpies.click).toHaveBeenCalledOnce()
  })

  it('drops manual track calls while opted out', async () => {
    const { init, track } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, defaultTrackingConsent: 'denied' })
    track('signup', { plan: 'pro' })

    expect(transportSpies.send).not.toHaveBeenCalled()
  })

  it('resumes manual track calls after opt in', async () => {
    const { init, optInTracking, track } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, defaultTrackingConsent: 'denied' })
    optInTracking()
    track('signup', { plan: 'pro' })

    expect(transportSpies.send).toHaveBeenCalledOnce()
  })

  it('drops identify calls while opted out', async () => {
    const { identify, init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoCapture: false, defaultTrackingConsent: 'denied' })

    await expect(identify('user-1')).resolves.toBeUndefined()
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

  it('opt in restores the stored auto-capture selection', async () => {
    const { init, optInTracking } = await importPug()

    init('project-id', {
      apiKey: 'api-key',
      defaultTrackingConsent: 'denied',
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
})
