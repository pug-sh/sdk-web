import Cotton from '../cotton'

export function setupScrollTracking(cotton: Cotton) {
  let timer: any = null
  const THROTTLE_MS = 2000 // Track at most every 2 seconds

  window.addEventListener('scroll', () => {
    if (timer) return

    timer = setTimeout(() => {
      const scrollEventDetails = {
        scrollY: window.scrollY,
        percent: Math.round((window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100),
      }

      // Log the scroll event details to console
      console.log('[Cotton SDK] Scroll event details:', scrollEventDetails)

      cotton.track('scroll', scrollEventDetails)
      timer = null
    }, THROTTLE_MS)
  })
}
