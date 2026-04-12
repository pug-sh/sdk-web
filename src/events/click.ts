import type { TrackFn, WellKnownEventName } from '../track.js'

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
      text: target.innerText?.substring(0, 50) ?? '',
      x: event.clientX,
      y: event.clientY,
    })
  }

  window.addEventListener('click', onClick, true)

  return () => window.removeEventListener('click', onClick, true)
}
