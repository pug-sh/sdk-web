type TrackFn = (eventName: string, properties?: Record<string, any>) => void

export function setupPageViewTracking(track: TrackFn) {
  track('page_view')

  const originalPushState = history.pushState
  history.pushState = function (...args) {
    originalPushState.apply(this, args)
    try {
      track('page_view')
    } catch {}
  }

  const originalReplaceState = history.replaceState
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args)
    try {
      track('page_view')
    } catch {}
  }

  window.addEventListener('popstate', () => track('page_view'))
}
