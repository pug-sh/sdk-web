import Cotton from '../cotton'

export function setupFormTracking(cotton: Cotton) {
  const formsSeen = new WeakSet<HTMLFormElement>()

  window.addEventListener('focus', event => handleFormInteraction(event.target as HTMLElement, cotton, formsSeen), true)

  window.addEventListener('input', event => handleFormInteraction(event.target as HTMLElement, cotton, formsSeen), true)

  window.addEventListener(
    'submit',
    event => {
      const form = event.target as HTMLFormElement
      if (form) {
        const formSubmitEventDetails = {
          formId: form.id,
          formName: form.name,
          action: form.action,
        }

        console.log('[Cotton SDK] Form submit event details:', formSubmitEventDetails)

        cotton.track('form_submit', formSubmitEventDetails)
      }
    },
    true
  )
}

function handleFormInteraction(target: HTMLElement, cotton: Cotton, formsSeen: WeakSet<HTMLFormElement>) {
  if (!target) return
  const form = (target as any).form as HTMLFormElement

  if (form && !formsSeen.has(form)) {
    formsSeen.add(form)
    const formStartEventDetails = {
      formId: form.id,
      formName: form.name,
    }

    console.log('[Cotton SDK] Form start event details:', formStartEventDetails)

    cotton.track('form_start', formStartEventDetails)
  }
}
