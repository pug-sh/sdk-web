import type { TrackFn } from '../track.js'

export const eventFormStart = 'form_start'
export const eventFormSubmit = 'form_submit'

export const setupFormTracking = (track: TrackFn<typeof eventFormStart | typeof eventFormSubmit>) => {
  const formsSeen = new WeakSet<HTMLFormElement>()

  // form_start fires on first input, not focus — avoids false positives from tab navigation
  const onInput = (event: Event) => {
    if (!event.target) {
      return
    }
    const form = (event.target as HTMLInputElement).form

    if (form && !formsSeen.has(form)) {
      formsSeen.add(form)
      track(eventFormStart, {
        formId: form.id,
        formName: form.name,
      })
    }
  }

  const onSubmit = (event: Event) => {
    if (!event.target) {
      return
    }
    const form = event.target as HTMLFormElement
    track(eventFormSubmit, {
      action: form.action,
      formId: form.id,
      formName: form.name,
    })
  }

  window.addEventListener('input', onInput, true)
  window.addEventListener('submit', onSubmit, true)

  return () => {
    window.removeEventListener('input', onInput, true)
    window.removeEventListener('submit', onSubmit, true)
  }
}
