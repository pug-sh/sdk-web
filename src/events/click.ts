import type { TrackFn } from '../transport.js'

export type ClickEventName = 'click'

export function setupClickTracking(track: TrackFn<ClickEventName>) {
  window.addEventListener(
    'click',
    event => {
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

      track('click', clickEventDetails)
    },
    true
  )
}
