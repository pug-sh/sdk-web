import Cotton from '../cotton';

export function setupClickTracking(cotton: Cotton) {
  window.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    cotton.track('click', {
      tag: target.tagName,
      id: target.id,
      className: target.className,
      text: target.innerText?.substring(0, 50), // Truncate text
      x: event.clientX,
      y: event.clientY,
    });
  }, true); // Capture phase to catch all clicks
}
