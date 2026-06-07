import { setupClickTracking } from './events/click.js'
import { setupFormTracking } from './events/form.js'
import { setupDeadClickTracking, setupRageClickTracking } from './events/frustration.js'
import { setupPageViewTracking } from './events/page_view.js'
import { setupScrollTracking } from './events/scroll.js'
import { log } from './logger.js'
import type { TrackFn } from './track.js'

/**
 * Per-listener allowlist for automatic capture.
 *
 * Allowlist semantics: a listener is enabled only when its key is explicitly `true`.
 * An omitted key, `undefined`, and `false` all mean "disabled" — so `{}` disables
 * everything, equivalent to passing `false` as the whole `AutoCaptureConfig`.
 */
export interface AutoCaptureSelection {
  readonly pageView?: boolean
  readonly click?: boolean
  readonly scroll?: boolean
  readonly form?: boolean
  readonly rageClick?: boolean
  readonly deadClick?: boolean
}

/** `true` enables all listeners, `false` disables all, an object is a per-listener allowlist. */
export type AutoCaptureConfig = boolean | AutoCaptureSelection

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

const normalizeAutoCapture = (autoCapture: AutoCaptureConfig | undefined): AutoCaptureKey[] => {
  if (autoCapture === undefined || autoCapture === true) {
    return trackerKeys
  }
  if (autoCapture === false) {
    return []
  }
  // Two failure policies for malformed JS input (TS callers are constrained by the type):
  // a wrong top-level type is most likely a mistake, so default to all trackers; a mostly-valid
  // object with a few bad fields keeps the good keys and ignores the rest.
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

/**
 * Owns the auto-capture lifecycle. Holds the desired selection and reconciles the live SDK
 * listeners against it, gated by consent (read via `isConsentGranted`): while consent is denied no
 * listener runs, regardless of the desired selection. Cleanup is tracked per tracker so the
 * selection can be changed at runtime without tearing down listeners that stay enabled.
 */
export const createAutoCaptureController = (track: TrackFn, isConsentGranted: () => boolean) => {
  const cleanups = new Map<AutoCaptureKey, () => void>()
  let desired: AutoCaptureConfig | undefined

  const disable = (key: AutoCaptureKey): void => {
    const cleanup = cleanups.get(key)
    if (!cleanup) {
      return
    }
    try {
      cleanup()
    } catch (err) {
      log.error(`Error during cleanup of "${key}":`, err)
    }
    cleanups.delete(key)
  }

  const enable = (key: AutoCaptureKey): boolean => {
    if (cleanups.has(key)) {
      return true
    }
    try {
      cleanups.set(key, trackers[key](track))
      return true
    } catch (err) {
      log.error(`Failed to initialize tracker "${key}":`, err)
      return false
    }
  }

  // Effective listeners = desired selection gated by consent. Idempotent: already-enabled trackers
  // that stay enabled are left untouched (no teardown + re-setup).
  const reconcile = (): void => {
    const enabledTrackers = new Set(isConsentGranted() ? normalizeAutoCapture(desired) : [])

    for (const key of trackerKeys) {
      if (!enabledTrackers.has(key)) {
        disable(key)
      }
    }

    let failedCount = 0
    for (const key of enabledTrackers) {
      if (!enable(key)) {
        failedCount++
      }
    }

    if (failedCount > 0) {
      log.error(`${failedCount}/${enabledTrackers.size} trackers failed to initialize.`)
    }

    if (enabledTrackers.size === 0) {
      log.debug('Auto-capture disabled: no trackers are active.')
    }
  }

  return {
    /** Store the desired selection and reconcile the live listeners against current consent. */
    setDesired: (autoCapture: AutoCaptureConfig | undefined): void => {
      desired = autoCapture
      reconcile()
    },
    /** Re-reconcile after a consent change, reusing the stored selection. */
    apply: (): void => {
      reconcile()
    },
    /** Tear down every active listener (called on `destroy()`). */
    destroy: (): void => {
      for (const key of trackerKeys) {
        disable(key)
      }
    },
  }
}

export type AutoCaptureController = ReturnType<typeof createAutoCaptureController>
