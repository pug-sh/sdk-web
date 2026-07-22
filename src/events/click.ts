import type { TrackFn, WellKnownEventName } from '../track.js'
import { getSafeElementText } from '../utils.js'

export const eventClick = 'click' satisfies WellKnownEventName

const MAX_TEXT_LENGTH = 50

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
      // Own text only; structural fields still send so the click keeps counting.
      text: getSafeElementText(target, MAX_TEXT_LENGTH),
      x: event.clientX,
      y: event.clientY,
    })
  }

  window.addEventListener('click', onClick, true)

  return () => window.removeEventListener('click', onClick, true)
}
