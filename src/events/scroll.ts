type TrackFn = (eventName: string, properties?: Record<string, any>) => void

export function setupScrollTracking(track: TrackFn) {
  let timer: any = null
  const THROTTLE_MS = 2000 // Track at most every 2 seconds

  window.addEventListener('scroll', () => {
    if (timer) return

    timer = setTimeout(() => {
      const scrollable = document.body.scrollHeight - window.innerHeight
      const scrollEventDetails = {
        scrollY: window.scrollY,
        percent: scrollable > 0 ? Math.round((window.scrollY / scrollable) * 100) : 0,
      }

      // Log the scroll event details to console
      console.debug('[Cotton SDK] Scroll event details:', scrollEventDetails)

      track('scroll', scrollEventDetails)
      timer = null
    }, THROTTLE_MS)
  })
}
