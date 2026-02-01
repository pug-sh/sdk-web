import type { TrackFn } from '../transport.js'

export type FormEventName = 'form_start' | 'form_submit'

export function setupFormTracking(track: TrackFn<FormEventName>): () => void {
  const formsSeen = new WeakSet<HTMLFormElement>()

  // form_start fires on first input, not focus — avoids false positives from tab navigation
  const onInput = (event: Event) => {
    if (!event.target) {
      return
    }
    const form = (event.target as HTMLInputElement).form

    if (form && !formsSeen.has(form)) {
      formsSeen.add(form)
      track('form_start', {
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
    track('form_submit', {
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
