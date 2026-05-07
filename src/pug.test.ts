import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cleanupSpies = {
  pageView: vi.fn(),
  click: vi.fn(),
  scroll: vi.fn(),
  form: vi.fn(),
  rageClick: vi.fn(),
  deadClick: vi.fn(),
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
  createBatchedTransport: vi.fn(() => ({ destroy: vi.fn() })),
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
  resolveSessionId: vi.fn(() => 'session-id'),
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
}))

const importPug = async () => import('./pug.js')

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(async () => {
  const { destroy } = await importPug()
  destroy()
})

describe('init autoTrack', () => {
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
      autoTrack: { pageView: true, click: true, scroll: false },
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
      autoTrack: { scroll: true },
    })

    expect(trackerSpies.pageView).not.toHaveBeenCalled()
    expect(trackerSpies.click).not.toHaveBeenCalled()
    expect(trackerSpies.scroll).toHaveBeenCalledOnce()
    expect(trackerSpies.form).not.toHaveBeenCalled()
    expect(trackerSpies.rageClick).not.toHaveBeenCalled()
    expect(trackerSpies.deadClick).not.toHaveBeenCalled()
  })

  it('disables all trackers when autoTrack is false', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoTrack: false })

    expect(trackerSpies.pageView).not.toHaveBeenCalled()
    expect(trackerSpies.click).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('autoTrack disabled'))
  })

  it('defaults to all trackers for invalid autoTrack shapes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { init } = await importPug()

    init('project-id', { apiKey: 'api-key', autoTrack: 'yes' as never })

    expect(trackerSpies.pageView).toHaveBeenCalledOnce()
    expect(trackerSpies.click).toHaveBeenCalledOnce()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('autoTrack must be a boolean or object'))
  })
})
