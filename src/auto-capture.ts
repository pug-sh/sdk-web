import { setupClickTracking } from './events/click.js'
import { setupFormTracking } from './events/form.js'
import { setupDeadClickTracking, setupRageClickTracking } from './events/frustration.js'
import { setupPageViewTracking } from './events/page_view.js'
import { setupScrollTracking } from './events/scroll.js'
import { log } from './logger.js'
import type { TrackFn } from './track.js'
import type { TrackingGate } from './tracking-consent.js'

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
 *
 * The `| undefined` is what keeps that last idiom compiling for consumers who enable
 * `exactOptionalPropertyTypes` (it ships in `@tsconfig/strictest`), where an optional key does not
 * otherwise admit an explicit `undefined`. It is a no-op without that flag, and it does not weaken
 * anything: `false` and a `boolean`-typed value are still rejected.
 */
export interface AutoCaptureSelection {
  readonly pageView?: true | undefined
  readonly click?: true | undefined
  readonly scroll?: true | undefined
  readonly form?: true | undefined
  readonly rageClick?: true | undefined
  readonly deadClick?: true | undefined
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

/**
 * Resolves a selection to the trackers it enables. Pure: every diagnostic lives in
 * `validateAutoCapture`, because this runs on each reconcile while warnings must fire exactly once,
 * at config time.
 *
 * A wrong top-level type defaults to all trackers (most likely a mistake, and capture is the
 * default); a mostly-valid object keeps its good keys and ignores the rest.
 */
const resolveAutoCapture = (autoCapture: AutoCaptureConfig | undefined): AutoCaptureKey[] => {
  if (autoCapture === undefined || autoCapture === true) {
    return trackerKeys
  }
  if (autoCapture === false) {
    return []
  }
  if (typeof autoCapture !== 'object' || autoCapture === null || Array.isArray(autoCapture)) {
    return trackerKeys
  }
  const selection = autoCapture as Record<string, unknown>
  return trackerKeys.filter(key => selection[key] === true)
}

/**
 * Reports a misconfigured selection, once, when it is set.
 *
 * Deliberately called from `setDesired` rather than from `reconcile`: reconcile only consults the
 * selection while tracking is active (granted **or** cookieless), so validating there would say nothing at all for the
 * consent-first flows the README recommends — the integrator would get the diagnosis at
 * `optInTracking()` time, in a user's browser, long after they stopped watching the console — and
 * would then re-warn on every opt-in/opt-out cycle.
 */
const validateAutoCapture = (autoCapture: AutoCaptureConfig | undefined): void => {
  if (autoCapture === undefined || typeof autoCapture === 'boolean') {
    return
  }
  if (typeof autoCapture !== 'object' || autoCapture === null || Array.isArray(autoCapture)) {
    log.warn(`autoCapture must be a boolean or object, got ${typeof autoCapture}. Defaulting to all trackers.`)
    return
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
    log.warn(`autoCapture values must be \`true\` for keys: ${invalidKeys.join(', ')}. Ignoring invalid values.`)
  }

  // Two spellings of one mistake — the allowlist misread as a denylist — and both must be audible,
  // because each silently loses capture the integrator believes they kept.
  //
  //   1. An explicit `false` (`{ deadClick: false }` for "everything except dead clicks"). This is
  //      reported even when the selection still enables something: `{ pageView: true, scroll: false }`
  //      keeps page views, so a check keyed only on a zero enabled count stays silent while click,
  //      form, rageClick and deadClick are all lost.
  //   2. A selection that names trackers but enables none — an unknown key (`{ pageview: true }`) or
  //      a non-`true` value (`{ scroll: 'true' }` from a template, `{ scroll: 1 }` from a config
  //      store). The `invalidKeys` warning above names the offending key but reads as "we ignored
  //      that one", which understates a total loss of capture.
  //
  // Keyed on a written-out value rather than on key count, so the documented runtime-flag idiom
  // `scroll: flag || undefined` stays silent when the flag is false — it embeds no misconception,
  // exactly like `{}`. TS callers cannot write either mistake without a cast (AutoCaptureSelection's
  // values are typed `true`), but JS and CDN callers can.
  const enabled = trackerKeys.filter(key => selection[key] === true)
  const disabledKeys = trackerKeys.filter(key => selection[key] === false)
  const namesSomething = Object.keys(selection).some(key => selection[key] !== undefined)

  if (disabledKeys.length > 0 || (enabled.length === 0 && namesSomething)) {
    const cause =
      disabledKeys.length > 0
        ? `\`false\` on ${disabledKeys.join(', ')} changes nothing: those trackers are off either way, as is ` +
          'every key you did not list.'
        : 'a tracker runs only when its key is set to `true`, and this selection sets none.'
    log.warn(
      `autoCapture is an allowlist — only keys set to \`true\` are enabled — so ${cause} ` +
        `This selection enables ${enabled.length > 0 ? enabled.join(', ') : 'nothing at all'}. Pass ` +
        '`false` as the whole autoCapture value to disable capture deliberately.',
    )
  }
}

/**
 * Owns the auto-capture lifecycle. Holds the desired selection and reconciles the live SDK
 * listeners against it, gated by tracking being active (read via `isTrackingActive` — true for
 * granted AND cookieless consent, not just full consent): while tracking is off no listener runs,
 * regardless of the desired selection. Cleanup is tracked per tracker so the selection can be
 * changed at runtime without tearing down listeners that stay enabled.
 */
export const createAutoCaptureController = (track: TrackFn, isTrackingActive: TrackingGate) => {
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

  // Effective listeners = desired selection gated by tracking being active. Idempotent:
  // already-enabled trackers that stay enabled are left untouched (no teardown + re-setup).
  const reconcile = (): void => {
    const enabledTrackers = new Set(isTrackingActive() ? resolveAutoCapture(desired) : [])

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
    /**
     * Store the desired selection and reconcile the live listeners against current consent.
     * Validation happens here, not in `reconcile`, so a bad selection is reported when it is set
     * even if consent is currently denied.
     */
    setDesired: (autoCapture: AutoCaptureConfig | undefined): void => {
      validateAutoCapture(autoCapture)
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
