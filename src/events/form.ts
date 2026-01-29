type TrackFn = (eventName: string, properties?: Record<string, any>) => void

export function setupFormTracking(track: TrackFn) {
  const formsSeen = new WeakSet<HTMLFormElement>()

  window.addEventListener('input', event => handleFormInteraction(event.target as HTMLElement, track, formsSeen), true)

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

        console.debug('[Cotton SDK] Form submit event details:', formSubmitEventDetails)

        track('form_submit', formSubmitEventDetails)
      }
    },
    true
  )
}

function handleFormInteraction(target: HTMLElement, track: TrackFn, formsSeen: WeakSet<HTMLFormElement>) {
  if (!target) return
  const form = (target as any).form as HTMLFormElement

  if (form && !formsSeen.has(form)) {
    formsSeen.add(form)
    const formStartEventDetails = {
      formId: form.id,
      formName: form.name,
    }

    console.debug('[Cotton SDK] Form start event details:', formStartEventDetails)

    track('form_start', formStartEventDetails)
  }
}
