import type { TrackFn } from '../transport.js'

export type PageViewEventName = 'page_view'

export function setupPageViewTracking(track: TrackFn<PageViewEventName>) {
  track('page_view')

  const originalPushState = history.pushState
  const wrappedPushState = function (this: History, ...args: Parameters<typeof history.pushState>) {
    originalPushState.apply(this, args)
    track('page_view')
  }
  history.pushState = wrappedPushState

  const originalReplaceState = history.replaceState
  const wrappedReplaceState = function (this: History, ...args: Parameters<typeof history.replaceState>) {
    originalReplaceState.apply(this, args)
    track('page_view')
  }
  history.replaceState = wrappedReplaceState

  const onPopState = () => track('page_view')
  window.addEventListener('popstate', onPopState)

  return () => {
    window.removeEventListener('popstate', onPopState)
    // Only restore if no one else has wrapped on top of us
    if (history.pushState === wrappedPushState) {
      history.pushState = originalPushState
    }
    if (history.replaceState === wrappedReplaceState) {
      history.replaceState = originalReplaceState
    }
  }
}
