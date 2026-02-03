import type { TrackFn } from '../transport.js'

export type PageViewEventName = 'page_view'

// store originals at module level for restoration
let origPush: typeof history.pushState | null = null
let origReplace: typeof history.replaceState | null = null

// store wrappers at module level for cleanup comparisons
let wrapPush: typeof history.pushState | null = null
let wrapReplace: typeof history.replaceState | null = null

let orphaned = false

export function setupPageViewTracking(track: TrackFn<PageViewEventName>): () => void {
  track('page_view')

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
        track('page_view')
      }
    }
    history.pushState = wrapPush
  }

  if (origReplace === history.replaceState) {
    const trueReplace = origReplace
    wrapReplace = function (this: History, ...args: Parameters<typeof history.replaceState>) {
      trueReplace.apply(this, args)
      if (!orphaned) {
        track('page_view')
      }
    }
    history.replaceState = wrapReplace
  }

  const onPopState = () => track('page_view')
  window.addEventListener('popstate', onPopState)

  return () => {
    window.removeEventListener('popstate', onPopState)

    // only restore if no one else has wrapped on top of us
    if (history.pushState === wrapPush) {
      history.pushState = origPush!
    } else {
      orphaned = true
      console.warn('[Cotton SDK] history.pushState was patched by a third party after init, skipping restore.')
    }
    if (history.replaceState === wrapReplace) {
      history.replaceState = origReplace!
    } else {
      orphaned = true
      console.warn('[Cotton SDK] history.replaceState was patched by a third party after init, skipping restore.')
    }
  }
}
