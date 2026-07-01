import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureUrlSanitizer } from '../track.js'
import { setupFormTracking } from './form.js'

describe('setupFormTracking', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    configureUrlSanitizer(undefined)
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

  it('runs the form action through the configured URL sanitizer on submit', () => {
    configureUrlSanitizer(url => url.replace(/\/orders\/\d+/, '/orders/:orderId'))
    const track = vi.fn()
    cleanup = setupFormTracking(track)
    const { form } = buildForm()
    form.setAttribute('action', '/orders/12345')

    form.dispatchEvent(new Event('submit', { bubbles: true }))

    expect(track).toHaveBeenCalledWith(
      'form_submit',
      expect.objectContaining({ action: expect.stringContaining('/orders/:orderId') }),
    )
    expect(track).toHaveBeenCalledWith(
      'form_submit',
      expect.objectContaining({ action: expect.not.stringContaining('12345') }),
    )
  })

  it('passes the action through unchanged when no sanitizer is configured', () => {
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
