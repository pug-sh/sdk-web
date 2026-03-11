import type { TrackFn } from '../track.js'

export const eventClick = 'click'

export const setupClickTracking = (track: TrackFn<typeof eventClick>) => {
  const onClick = (event: MouseEvent) => {
    if (!event.target) {
      return
    }
    const target = event.target as HTMLElement
    const clickEventDetails = {
      className: target.getAttribute('class') ?? '',
      id: target.id,
      tag: target.tagName,
      text: target.innerText?.substring(0, 50) ?? '',
      x: event.clientX,
      y: event.clientY,
    }

    track(eventClick, clickEventDetails)
  }

  window.addEventListener('click', onClick, true)

  return () => window.removeEventListener('click', onClick, true)
}
