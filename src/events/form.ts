import type { TrackFn } from '../transport.js'

export type FormEventName = 'form_start' | 'form_submit'

export function setupFormTracking(track: TrackFn<FormEventName>) {
  const formsSeen = new WeakSet<HTMLFormElement>()

  // form_start fires on first input, not focus — avoids false positives from tab navigation
  window.addEventListener(
    'input',
    event => {
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
    },
    true
  )

  window.addEventListener(
    'submit',
    event => {
      if (!event.target) {
        return
      }
      const form = event.target as HTMLFormElement
      track('form_submit', {
        action: form.action,
        formId: form.id,
        formName: form.name,
      })
    },
    true
  )
}
