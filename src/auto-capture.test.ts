import { beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.hoisted` because the `vi.mock` factories below are hoisted above plain `const` declarations,
// and this file imports the module under test statically.
const logSpies = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('./logger.js', () => ({
  log: logSpies,
  setDebugLogging: vi.fn(),
}))

const trackerSpies = vi.hoisted(() => ({
  pageView: vi.fn(() => vi.fn()),
  click: vi.fn(() => vi.fn()),
  scroll: vi.fn(() => vi.fn()),
  form: vi.fn(() => vi.fn()),
  rageClick: vi.fn(() => vi.fn()),
  deadClick: vi.fn(() => vi.fn()),
}))

vi.mock('./events/page_view.js', () => ({ setupPageViewTracking: trackerSpies.pageView }))
vi.mock('./events/click.js', () => ({ setupClickTracking: trackerSpies.click }))
vi.mock('./events/scroll.js', () => ({ setupScrollTracking: trackerSpies.scroll }))
vi.mock('./events/form.js', () => ({ setupFormTracking: trackerSpies.form }))
vi.mock('./events/frustration.js', () => ({
  setupRageClickTracking: trackerSpies.rageClick,
  setupDeadClickTracking: trackerSpies.deadClick,
}))

import { type AutoCaptureConfig, createAutoCaptureController } from './auto-capture.js'

const ALLOWLIST_WARNING = 'autoCapture is an allowlist'

/** Builds a controller with consent granted by default, and returns it plus a consent toggle. */
const makeController = (granted = true) => {
  let consent = granted
  const controller = createAutoCaptureController(vi.fn(), () => consent)
  return { controller, setConsent: (next: boolean) => (consent = next) }
}

/** `setDesired` takes a typed config; JS/CDN callers reach these shapes without the type. */
const setUntyped = (controller: ReturnType<typeof makeController>['controller'], value: unknown): void =>
  controller.setDesired(value as AutoCaptureConfig)

const enabledTrackers = (): string[] =>
  Object.entries(trackerSpies)
    .filter(([, spy]) => spy.mock.calls.length > 0)
    .map(([key]) => key)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('allowlist diagnostics', () => {
  // A selection that names trackers but enables none is a total, silent loss of capture. The
  // `invalidKeys` warning alone reads as "we skipped that one key", which understates it.
  it.each([
    ['a stringified boolean', { scroll: 'true' }],
    ['a numeric 0', { scroll: 0 }],
    ['a numeric 1', { scroll: 1 }],
    ['null', { scroll: null }],
    ['an empty string', { scroll: '' }],
  ])('warns that capture is off when a value is %s', (_label, selection) => {
    const { controller } = makeController()

    setUntyped(controller, selection)

    expect(enabledTrackers()).toEqual([])
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining(ALLOWLIST_WARNING))
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('nothing at all'))
  })

  it('warns that capture is off when every named key is unknown', () => {
    const { controller } = makeController()

    setUntyped(controller, { pageview: true })

    expect(enabledTrackers()).toEqual([])
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('Unknown autoCapture keys: pageview'))
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining(ALLOWLIST_WARNING))
  })

  it('names what survived when a selection mixes `true` with an explicit `false`', () => {
    const { controller } = makeController()

    setUntyped(controller, { pageView: true, scroll: false })

    expect(enabledTrackers()).toEqual(['pageView'])
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('This selection enables pageView.'))
  })

  // `{}` and the documented `scroll: flag || undefined` idiom (with the flag false) both resolve to
  // an explicitly-written `undefined`, which embeds no misconception and must stay silent.
  it.each([
    ['an empty object', {}],
    ['an explicit undefined value', { scroll: undefined }],
  ])('stays silent for %s', (_label, selection) => {
    const { controller } = makeController()

    setUntyped(controller, selection)

    expect(enabledTrackers()).toEqual([])
    expect(logSpies.warn).not.toHaveBeenCalledWith(expect.stringContaining(ALLOWLIST_WARNING))
  })

  it('stays silent for a selection that only enables', () => {
    const { controller } = makeController()

    controller.setDesired({ scroll: true })

    expect(enabledTrackers()).toEqual(['scroll'])
    expect(logSpies.warn).not.toHaveBeenCalled()
  })
})

describe('malformed top-level values', () => {
  // `null` and arrays are typeof 'object'; without their guards `Object.keys(null)` throws out of
  // init(), and an array resolves to zero trackers with no diagnostic at all.
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'all'],
  ])('warns and falls back to all trackers for %s', (_label, value) => {
    const { controller } = makeController()

    expect(() => setUntyped(controller, value)).not.toThrow()

    expect(enabledTrackers()).toHaveLength(6)
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('autoCapture must be a boolean or object'))
  })
})

describe('validation timing', () => {
  // Validation lives in setDesired, not reconcile: a consent-first integrator must hear about a bad
  // selection at init(), and must not be re-warned on every opt-in/opt-out cycle thereafter.
  it('validates once at config time, not on each consent change', () => {
    const { controller, setConsent } = makeController(false)

    setUntyped(controller, { deadClick: false })
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining(ALLOWLIST_WARNING))

    logSpies.warn.mockClear()
    setConsent(true)
    controller.apply()
    setConsent(false)
    controller.apply()

    expect(logSpies.warn).not.toHaveBeenCalled()
  })

  it('re-validates each time a new selection is set', () => {
    const { controller } = makeController()

    setUntyped(controller, { deadClick: false })
    setUntyped(controller, { deadClick: false })

    const allowlistWarnings = logSpies.warn.mock.calls.filter(([msg]) => String(msg).includes(ALLOWLIST_WARNING))
    expect(allowlistWarnings).toHaveLength(2)
  })
})
