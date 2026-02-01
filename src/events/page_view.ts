import type { TrackFn } from '../transport.js'

export type PageViewEventName = 'page_view'

export function setupPageViewTracking(track: TrackFn<PageViewEventName>): () => void {
  track('page_view')

  let active = true

  const originalPushState = history.pushState
  history.pushState = function (...args) {
    originalPushState.apply(this, args)
    if (active) track('page_view')
  }

  const originalReplaceState = history.replaceState
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args)
    if (active) track('page_view')
  }

  const onPopState = () => track('page_view')
  window.addEventListener('popstate', onPopState)

  return () => {
    active = false
    window.removeEventListener('popstate', onPopState)
  }
}
