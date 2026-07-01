import type { TrackFn, WellKnownEventName } from '../track.js'
import { isCaptureSuppressed } from '../utils.js'

export const eventClick = 'click' satisfies WellKnownEventName

export const setupClickTracking = (track: TrackFn) => {
  const onClick = (event: MouseEvent) => {
    if (!event.target) {
      return
    }
    const target = event.target as HTMLElement
    track(eventClick, {
      class: target.getAttribute('class') ?? '',
      id: target.id,
      tag: target.tagName,
      // Redact text the integrator marked sensitive; keep the structural fields so the click still counts.
      text: isCaptureSuppressed(target) ? '' : (target.innerText?.substring(0, 50) ?? ''),
      x: event.clientX,
      y: event.clientY,
    })
  }

  window.addEventListener('click', onClick, true)

  return () => window.removeEventListener('click', onClick, true)
}
