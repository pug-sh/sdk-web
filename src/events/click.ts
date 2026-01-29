import Cotton from '../cotton'

export function setupClickTracking(cotton: Cotton) {
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

      console.log('[Cotton SDK] Button click event details:', clickEventDetails)

      cotton.track('click', clickEventDetails)
    },
    true
  )
}
