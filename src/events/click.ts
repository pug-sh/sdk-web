type TrackFn = (eventName: string, properties?: Record<string, any>) => void

export function setupClickTracking(track: TrackFn) {
  window.addEventListener(
    'click',
    event => {
      const target = event.target as HTMLElement
      const clickEventDetails = {
        tag: target.tagName,
        id: target.id,
        className: target.className,
        text: target.innerText?.substring(0, 50),
        x: event.clientX,
        y: event.clientY,
      }

      console.debug('[Cotton SDK] Button click event details:', clickEventDetails)

      track('click', clickEventDetails)
    },
    true
  )
}
