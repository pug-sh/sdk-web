import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupFormTracking } from './form.js'

describe('setupFormTracking', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    document.body.innerHTML = ''
  })

  const buildForm = (): { form: HTMLFormElement; input: HTMLInputElement } => {
    const form = document.createElement('form')
    form.id = 'signup'
    form.setAttribute('name', 'signup-form')
    const input = document.createElement('input')
    input.name = 'email'
    form.appendChild(input)
    document.body.appendChild(form)
    return { form, input }
  }

  it('fires form_start once on first input', () => {
    const track = vi.fn()
    cleanup = setupFormTracking(track)
    const { input } = buildForm()

    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('form_start', { formId: 'signup', formName: 'signup-form' })
  })

  it("sends the form action as-is (redaction is beforeSend's job)", () => {
    const track = vi.fn()
    cleanup = setupFormTracking(track)
    const { form } = buildForm()
    form.setAttribute('action', '/plain/path')

    form.dispatchEvent(new Event('submit', { bubbles: true }))

    expect(track).toHaveBeenCalledWith(
      'form_submit',
      expect.objectContaining({ action: expect.stringContaining('/plain/path'), formId: 'signup' }),
    )
  })
})
