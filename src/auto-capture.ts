import { setupClickTracking } from './events/click.js'
import { setupFormTracking } from './events/form.js'
import { setupDeadClickTracking, setupRageClickTracking } from './events/frustration.js'
import { setupPageViewTracking } from './events/page_view.js'
import { setupScrollTracking } from './events/scroll.js'
import { log } from './logger.js'
import type { TrackFn } from './track.js'

export interface AutoCaptureSelection {
  readonly pageView?: boolean
  readonly click?: boolean
  readonly scroll?: boolean
  readonly form?: boolean
  readonly rageClick?: boolean
  readonly deadClick?: boolean
}

export type AutoCaptureOptions = boolean | AutoCaptureSelection

type AutoCaptureKey = keyof AutoCaptureSelection

const trackers = {
  pageView: setupPageViewTracking,
  click: setupClickTracking,
  scroll: setupScrollTracking,
  form: setupFormTracking,
  rageClick: setupRageClickTracking,
  deadClick: setupDeadClickTracking,
} satisfies Record<AutoCaptureKey, (track: TrackFn) => () => void>

const trackerKeys = Object.keys(trackers) as AutoCaptureKey[]

const normalizeAutoCapture = (autoCapture: AutoCaptureOptions | undefined): AutoCaptureKey[] => {
  if (autoCapture === undefined || autoCapture === true) {
    return trackerKeys
  }
  if (autoCapture === false) {
    return []
  }
  if (typeof autoCapture !== 'object' || autoCapture === null || Array.isArray(autoCapture)) {
    log.warn(`autoCapture must be a boolean or object, got ${typeof autoCapture}. Defaulting to all trackers.`)
    return trackerKeys
  }

  const unknownKeys = Object.keys(autoCapture).filter(
    (key): key is string => !trackerKeys.includes(key as AutoCaptureKey),
  )
  if (unknownKeys.length > 0) {
    log.warn(`Unknown autoCapture keys: ${unknownKeys.join(', ')}. Supported keys: ${trackerKeys.join(', ')}`)
  }

  const invalidKeys = trackerKeys.filter(key => autoCapture[key] !== undefined && typeof autoCapture[key] !== 'boolean')
  if (invalidKeys.length > 0) {
    log.warn(`autoCapture values must be boolean for keys: ${invalidKeys.join(', ')}. Ignoring invalid values.`)
  }

  return trackerKeys.filter(key => autoCapture[key] === true)
}

export const createAutoCaptureController = (track: TrackFn) => {
  const cleanups = new Map<AutoCaptureKey, { name: string; fn: () => void }>()

  const disable = (key: AutoCaptureKey): void => {
    const cleanup = cleanups.get(key)
    if (!cleanup) {
      return
    }
    try {
      cleanup.fn()
    } catch (err) {
      log.error(`Error during cleanup of "${cleanup.name}":`, err)
    }
    cleanups.delete(key)
  }

  const enable = (key: AutoCaptureKey): void => {
    if (cleanups.has(key)) {
      return
    }
    const setup = trackers[key]
    try {
      const cleanup = setup(track)
      cleanups.set(key, { name: setup.name, fn: cleanup })
    } catch (err) {
      log.error(`Failed to initialize tracker "${setup.name}":`, err)
    }
  }

  const set = (autoCapture: AutoCaptureOptions | undefined): void => {
    const enabledTrackers = new Set(normalizeAutoCapture(autoCapture))

    for (const key of trackerKeys) {
      if (!enabledTrackers.has(key)) {
        disable(key)
      }
    }

    for (const key of enabledTrackers) {
      enable(key)
    }

    if (enabledTrackers.size === 0) {
      log.debug('Auto-capture disabled: no trackers are active.')
    }
  }

  const destroy = (): void => {
    for (const key of trackerKeys) {
      disable(key)
    }
  }

  return { destroy, set }
}

export type AutoCaptureController = ReturnType<typeof createAutoCaptureController>
