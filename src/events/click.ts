import type { TrackFn } from '../transport.js'

export type ClickEventName = 'click'

export function setupClickTracking(track: TrackFn<ClickEventName>): () => void {
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

    track('click', clickEventDetails)
  }

  window.addEventListener('click', onClick, true)

  return () => {
    window.removeEventListener('click', onClick, true)
  }
}
