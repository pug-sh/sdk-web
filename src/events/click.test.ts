import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupClickTracking } from './click.js'

// jsdom does not implement innerText, so set it explicitly where a test needs real text.
const withInnerText = (el: HTMLElement, text: string): HTMLElement => {
  Object.defineProperty(el, 'innerText', { value: text, configurable: true })
  return el
}

describe('setupClickTracking', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    document.body.innerHTML = ''
  })

  it('captures element text, tag and coordinates on click', () => {
    const track = vi.fn()
    cleanup = setupClickTracking(track)

    const btn = withInnerText(document.createElement('button'), 'Add to cart')
    btn.id = 'buy'
    btn.className = 'cta primary'
    document.body.appendChild(btn)

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 12, clientY: 34 }))

    expect(track).toHaveBeenCalledWith('click', {
      class: 'cta primary',
      id: 'buy',
      tag: 'BUTTON',
      text: 'Add to cart',
      x: 12,
      y: 34,
    })
  })

  it('redacts text when the element is marked data-pug-no-capture, keeping structural fields', () => {
    const track = vi.fn()
    cleanup = setupClickTracking(track)

    const btn = withInnerText(document.createElement('button'), 'jane@example.com')
    btn.setAttribute('data-pug-no-capture', '')
    document.body.appendChild(btn)

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 2 }))

    expect(track).toHaveBeenCalledWith('click', expect.objectContaining({ tag: 'BUTTON', text: '', x: 1, y: 2 }))
  })

  it('redacts text when an ancestor is marked data-pug-no-capture', () => {
    const track = vi.fn()
    cleanup = setupClickTracking(track)

    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-pug-no-capture', '')
    const span = withInnerText(document.createElement('span'), 'SSN 123-45-6789')
    wrapper.appendChild(span)
    document.body.appendChild(wrapper)

    span.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(track).toHaveBeenCalledWith('click', expect.objectContaining({ tag: 'SPAN', text: '' }))
  })

  it('stops capturing after cleanup', () => {
    const track = vi.fn()
    const dispose = setupClickTracking(track)

    dispose()

    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(track).not.toHaveBeenCalled()
  })
})
