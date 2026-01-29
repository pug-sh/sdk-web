import Cotton from '../cotton'

export function setupPageViewTracking(cotton: Cotton) {
  // Track initial page load
  const pageViewEventDetails = {}

  // Log the page view event details to console
  console.log('[Cotton SDK] Page view event details:', pageViewEventDetails)

  cotton.track('page_view', pageViewEventDetails)

  // Track history changes
  const originalPushState = history.pushState
  history.pushState = function (...args) {
    originalPushState.apply(this, args)
    const pageViewEventDetails = {}

    // Log the page view event details to console
    console.log('[Cotton SDK] Page view event details:', pageViewEventDetails)

    cotton.track('page_view', pageViewEventDetails)
  }

  const originalReplaceState = history.replaceState
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args)
    const pageViewEventDetails = {}

    // Log the page view event details to console
    console.log('[Cotton SDK] Page view event details:', pageViewEventDetails)

    cotton.track('page_view', pageViewEventDetails)
  }

  window.addEventListener('popstate', () => {
    const pageViewEventDetails = {}

    // Log the page view event details to console
    console.log('[Cotton SDK] Page view event details:', pageViewEventDetails)

    cotton.track('page_view', pageViewEventDetails)
  })
}
