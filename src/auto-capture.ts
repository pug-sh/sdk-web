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
 * Allowlist semantics: a listener is enabled only when its key is explicitly `true`, and every
 * omitted key is disabled — so `{}` disables everything, equivalent to passing `false` as the whole
 * `AutoCaptureConfig`.
 *
 * The values are typed `true` rather than `boolean` to make that shape unwritable: `{ scroll: false }`
 * reads like "everything except scroll" but under an allowlist means "nothing at all", so it is a
 * compile error instead of a silent loss of all automatic capture. List what you want enabled
 * (`{ pageView: true }`), or pass `false` to turn everything off. For a value known only at runtime,
 * write `scroll: flag || undefined`.
 */
export interface AutoCaptureSelection {
  readonly pageView?: true
  readonly click?: true
  readonly scroll?: true
  readonly form?: true
  readonly rageClick?: true
  readonly deadClick?: true
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

  // The type constrains TS callers to `true`, but this value is runtime-untrusted: the CDN one-tag
  // install feeds it from data-options JSON.
  const selection = autoCapture as Record<string, unknown>

  const unknownKeys = Object.keys(selection).filter(key => !trackerKeys.includes(key as AutoCaptureKey))
  if (unknownKeys.length > 0) {
    log.warn(`Unknown autoCapture keys: ${unknownKeys.join(', ')}. Supported keys: ${trackerKeys.join(', ')}`)
  }

  const invalidKeys = trackerKeys.filter(key => selection[key] !== undefined && typeof selection[key] !== 'boolean')
  if (invalidKeys.length > 0) {
    log.warn(`autoCapture values must be boolean for keys: ${invalidKeys.join(', ')}. Ignoring invalid values.`)
  }

  const enabled = trackerKeys.filter(key => selection[key] === true)
  // An object that names trackers but enables none is the allowlist misread as a denylist
  // (`{ deadClick: false }` meaning "everything except dead clicks"), which silently yields no
  // capture at all. TS callers cannot express it — AutoCaptureSelection's values are typed `true` —
  // but JS and CDN callers can, so the loss has to be audible rather than a debug line.
  if (enabled.length === 0 && trackerKeys.some(key => selection[key] !== undefined)) {
    log.warn(
      'autoCapture is an allowlist — only keys set to `true` are enabled — so this selection disables ALL ' +
        'automatic capture. List the trackers to enable (e.g. { pageView: true }), or pass `false` to disable ' +
        'capture deliberately.',
    )
  }
  return enabled
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
