import Cotton from '../cotton';

export function setupFormTracking(cotton: Cotton) {
  const formsSeen = new WeakSet<HTMLFormElement>();

  // Use capture phase to detect focus/input anywhere
  window.addEventListener('focus', (event) => {
    handleFormInteraction(event.target as HTMLElement, cotton, formsSeen);
  }, true);

  window.addEventListener('input', (event) => {
    handleFormInteraction(event.target as HTMLElement, cotton, formsSeen);
  }, true);

  window.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement;
    if (form) {
      cotton.track('form_submit', {
        formId: form.id,
        formName: form.name,
        action: form.action
      });
    }
  }, true);
}

function handleFormInteraction(target: HTMLElement, cotton: Cotton, formsSeen: WeakSet<HTMLFormElement>) {
  if (!target) return;
  const form = (target as any).form as HTMLFormElement; // Inputs usually have .form property

  if (form && !formsSeen.has(form)) {
    formsSeen.add(form);
    cotton.track('form_start', {
      formId: form.id,
      formName: form.name
    });
  }
}
