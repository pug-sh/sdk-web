import type { TrackFn } from '../transport.js'

export type ScrollEventName = 'scroll'

export function setupScrollTracking(track: TrackFn<ScrollEventName>) {
  let timer: ReturnType<typeof setTimeout> | null = null
  // Throttle: captures scroll position at the end of the window, not at the trigger point
  const THROTTLE_MS = 2000

  window.addEventListener('scroll', () => {
    if (timer) {
      return
    }

    timer = setTimeout(() => {
      const scrollable = document.body.scrollHeight - window.innerHeight
      const scrollEventDetails = {
        percent: scrollable > 0 ? Math.round((window.scrollY / scrollable) * 100) : 0,
        scrollY: window.scrollY,
      }

      track('scroll', scrollEventDetails)
      timer = null
    }, THROTTLE_MS)
  })
}
