import Cotton from '../cotton';

export function setupFrustrationTracking(cotton: Cotton) {
  detectRageClicks(cotton);
  detectDeadClicks(cotton);
}

function detectRageClicks(cotton: Cotton) {
  const CLICKS_THRESHOLD = 3;
  const TIME_WINDOW = 1000; // ms
  const DISTANCE_THRESHOLD = 40; // pixels

  let clicks: { x: number; y: number; time: number }[] = [];

  window.addEventListener('click', (event) => {
    const now = Date.now();
    const newClick = { x: event.clientX, y: event.clientY, time: now };

    // Remove old clicks
    clicks = clicks.filter(c => now - c.time < TIME_WINDOW);
    clicks.push(newClick);

    if (clicks.length >= CLICKS_THRESHOLD) {
      // Check if all clicks are close to each other
      const first = clicks[0];
      const allClose = clicks.every(c =>
        Math.abs(c.x - first.x) < DISTANCE_THRESHOLD &&
        Math.abs(c.y - first.y) < DISTANCE_THRESHOLD
      );

      if (allClose) {
        cotton.track('rage_click', {
          clickCount: clicks.length,
          x: first.x,
          y: first.y,
          element: (event.target as HTMLElement).tagName
        });
        // Reset to avoid double counting
        clicks = [];
      }
    }
  }, true);
}

function detectDeadClicks(cotton: Cotton) {
  // A dead click is a click that has no effect (no visual change, no navigation)
  // We'll use specific heuristics:
  // 1. Click on non-interactive element? (hard to detect universally without access to computed styles simply)
  // 2. Click does NOT trigger DOM mutation or navigation soon after.

  window.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const isInteractive = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) ||
      target.onclick != null ||
      target.getAttribute('role') === 'button';

    // Dead clicks are interesting on things that *look* inactive or *should* be active but aren't.
    // Or things that are clicked but do nothing.
    // Let's assume everything is potentially interactive. 
    // If NO DOM mutation and NO URL change happens in 500ms, it's a "dead click" candidate?
    // This might be too noisy. 
    // Better definition: User clicks, nothing happens.

    const urlBefore = window.location.href;
    let mutationDetected = false;

    const observer = new MutationObserver(() => {
      mutationDetected = true;
    });
    observer.observe(document.body, { childList: true, attributes: true, subtree: true, characterData: true });

    setTimeout(() => {
      observer.disconnect();
      const urlAfter = window.location.href;

      if (urlBefore === urlAfter && !mutationDetected) {
        // Also check if it focused something (like an input) - that's an effect
        if (document.activeElement === target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
          return;
        }

        // If it's a "boring" click on empty body space, ignore
        if (target === document.body || target === document.documentElement) return;

        cotton.track('dead_click', {
          element: target.tagName,
          text: target.innerText?.substring(0, 20),
          x: event.clientX,
          y: event.clientY
        });
      }
    }, 500);

  }, true);
}
