import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupDeadClickTracking } from './frustration.js'

const withInnerText = (el: HTMLElement, text: string): HTMLElement => {
  Object.defineProperty(el, 'innerText', { value: text, configurable: true })
  return el
}

describe('setupDeadClickTracking', () => {
  let cleanup: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  // The dead-click detector waits 500ms and fires only if no DOM mutation or URL change happened.
  // We append the target and flush the MutationObserver microtask *before* clicking so the
  // mutation baseline is settled, then advance past the timeout with no further mutations.
  const clickAndSettle = async (target: HTMLElement): Promise<void> => {
    await Promise.resolve() // flush pending MutationObserver records from the append
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 7, clientY: 8 }))
    await vi.advanceTimersByTimeAsync(500)
  }

  it('captures element text on a dead click', async () => {
    const track = vi.fn()
    cleanup = setupDeadClickTracking(track)

    const div = withInnerText(document.createElement('div'), 'Submit order')
    document.body.appendChild(div)

    await clickAndSettle(div)

    expect(track).toHaveBeenCalledWith('dead_click', { element: 'DIV', text: 'Submit order', x: 7, y: 8 })
  })

  it('redacts text on a dead click inside a data-pug-no-capture region', async () => {
    const track = vi.fn()
    cleanup = setupDeadClickTracking(track)

    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-pug-no-capture', '')
    const div = withInnerText(document.createElement('div'), 'card 4111 1111 1111 1111')
    wrapper.appendChild(div)
    document.body.appendChild(wrapper)

    await clickAndSettle(div)

    expect(track).toHaveBeenCalledWith('dead_click', expect.objectContaining({ element: 'DIV', text: '' }))
  })

  it('redacts text on a dead click when the element itself is marked', async () => {
    const track = vi.fn()
    cleanup = setupDeadClickTracking(track)

    const div = withInnerText(document.createElement('div'), 'jane@example.com')
    div.setAttribute('data-pug-no-capture', '')
    document.body.appendChild(div)

    await clickAndSettle(div)

    expect(track).toHaveBeenCalledWith('dead_click', expect.objectContaining({ element: 'DIV', text: '' }))
  })
})
