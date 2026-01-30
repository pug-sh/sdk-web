import type { TrackFn } from '../transport.js'

export type PageViewEventName = 'page_view'

export function setupPageViewTracking(track: TrackFn<PageViewEventName>) {
  track('page_view')

  const originalPushState = history.pushState
  history.pushState = function (...args) {
    originalPushState.apply(this, args)
    track('page_view')
  }

  const originalReplaceState = history.replaceState
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args)
    track('page_view')
  }

  window.addEventListener('popstate', () => track('page_view'))
}
