import Cotton from '../cotton';

export function setupPageViewTracking(cotton: Cotton) {
  // Track initial page load
  cotton.track('page_view');

  // Track history changes
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    cotton.track('page_view');
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    cotton.track('page_view');
  };

  window.addEventListener('popstate', () => {
    cotton.track('page_view');
  });
}
