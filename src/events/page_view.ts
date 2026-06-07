import { log } from '../logger.js'
import type { TrackFn, WellKnownEventName } from '../track.js'

export const eventPageView = 'page_view' satisfies WellKnownEventName

// Stored at module level so they survive across init/destroy cycles. This enables
// restoring the original methods on destroy and reactivating orphaned wrappers on
// re-init. Relies on `track` being a stable module-level function in pug.ts.
let origPush: typeof history.pushState | null = null
let origReplace: typeof history.replaceState | null = null

// Stored at module level so cleanup can detect if a third party wrapped on top
// (i.e. history.pushState !== wrapPush means someone else patched after us).
let wrapPush: typeof history.pushState | null = null
let wrapReplace: typeof history.replaceState | null = null

let orphaned = false

export const setupPageViewTracking = (track: TrackFn) => {
  track(eventPageView)

  // capture originals on first init
  if (origPush === null) {
    origPush = history.pushState
    origReplace = history.replaceState
  }

  // reactivate orphaned wrappers if any
  orphaned = false

  // only wrap if no one has patched since we captured (check each separately)
  if (origPush === history.pushState) {
    const truePush = origPush
    wrapPush = function (this: History, ...args: Parameters<typeof history.pushState>) {
      truePush.apply(this, args)
      if (!orphaned) {
        track(eventPageView)
      }
    }
    history.pushState = wrapPush
  }

  if (origReplace === history.replaceState) {
    const trueReplace = origReplace
    wrapReplace = function (this: History, ...args: Parameters<typeof history.replaceState>) {
      trueReplace.apply(this, args)
      if (!orphaned) {
        track(eventPageView)
      }
    }
    history.replaceState = wrapReplace
  }

  const onPopState = () => track(eventPageView)
  window.addEventListener('popstate', onPopState)

  return () => {
    window.removeEventListener('popstate', onPopState)

    // only restore if no one else has wrapped on top of us
    if (history.pushState === wrapPush) {
      history.pushState = origPush!
    } else {
      orphaned = true
      log.warn('history.pushState was patched by a third party after init, skipping restore.')
    }
    if (history.replaceState === wrapReplace) {
      history.replaceState = origReplace!
    } else {
      orphaned = true
      log.warn('history.replaceState was patched by a third party after init, skipping restore.')
    }
  }
}
