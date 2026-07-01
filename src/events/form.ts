import { sanitizeUrlValue, type TrackFn, type WellKnownEventName } from '../track.js'

export const eventFormStart = 'form_start' satisfies WellKnownEventName
export const eventFormSubmit = 'form_submit' satisfies WellKnownEventName

export const setupFormTracking = (track: TrackFn) => {
  const formsSeen = new WeakSet<HTMLFormElement>()

  // form_start fires on first input, not focus — avoids false positives from tab navigation
  const onInput = (event: Event) => {
    if (!event.target) {
      return
    }
    const form = (event.target as HTMLInputElement).form

    if (form && !formsSeen.has(form)) {
      formsSeen.add(form)
      track(eventFormStart, { formId: form.id || '(anonymous)', formName: form.name })
    }
  }

  const onSubmit = (event: Event) => {
    if (!event.target) {
      return
    }
    const form = event.target as HTMLFormElement
    track(eventFormSubmit, {
      action: sanitizeUrlValue(form.action),
      formId: form.id || '(anonymous)',
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
