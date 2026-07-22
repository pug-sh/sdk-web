import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupClickTracking } from './click.js'

// textContent on a leaf creates exactly one child text node — real DOM, unlike the innerText stub
// this replaced, which faked a property jsdom does not implement and so never exercised the
// subtree-vs-own-text distinction the capture depends on.
const withText = <T extends HTMLElement>(el: T, text: string): T => {
  el.textContent = text
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

    const btn = withText(document.createElement('button'), 'Add to cart')
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

  // The click target is often a wrapper rather than the leaf under the pointer, so a card wrapping
  // personal data was captured whole — and a data-pug-no-capture marker on the sensitive leaf never
  // ran, because the read happened at the ancestor.
  it('captures the element own text only, never descendant text', () => {
    const track = vi.fn()
    cleanup = setupClickTracking(track)

    const card = withText(document.createElement('div'), 'Open ')
    card.appendChild(withText(document.createElement('span'), 'jane@example.com'))
    card.appendChild(withText(document.createElement('span'), '4111 1111 1111 1111'))
    document.body.appendChild(card)

    card.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(track).toHaveBeenCalledWith('click', expect.objectContaining({ tag: 'DIV', text: 'Open' }))
  })

  it('still captures a leaf own text when it is the click target', () => {
    const track = vi.fn()
    cleanup = setupClickTracking(track)

    const card = document.createElement('div')
    const span = withText(document.createElement('span'), 'Add to cart')
    card.appendChild(span)
    document.body.appendChild(card)

    span.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(track).toHaveBeenCalledWith('click', expect.objectContaining({ tag: 'SPAN', text: 'Add to cart' }))
  })

  it('collapses whitespace and truncates to 50 characters', () => {
    const track = vi.fn()
    cleanup = setupClickTracking(track)

    const btn = withText(document.createElement('button'), `\n   Buy  now\t${'x'.repeat(80)}\n`)
    document.body.appendChild(btn)

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const text = track.mock.calls[0][1].text as string
    expect(text).toBe(`Buy now ${'x'.repeat(42)}`)
    expect(text).toHaveLength(50)
  })

  it('captures no text from a textarea or a contenteditable region', () => {
    const track = vi.fn()
    cleanup = setupClickTracking(track)

    const area = withText(document.createElement('textarea'), 'my private draft')
    const editable = withText(document.createElement('div'), 'typed by the user')
    editable.setAttribute('contenteditable', '')
    document.body.append(area, editable)

    area.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    editable.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(track).toHaveBeenNthCalledWith(1, 'click', expect.objectContaining({ tag: 'TEXTAREA', text: '' }))
    expect(track).toHaveBeenNthCalledWith(2, 'click', expect.objectContaining({ tag: 'DIV', text: '' }))
  })

  // Every editor built on ProseMirror/Quill/Lexical puts contenteditable on a root and the click
  // lands on the child element holding the typed text.
  it('captures no text when the click lands inside a contenteditable region', () => {
    const track = vi.fn()
    cleanup = setupClickTracking(track)

    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const line = withText(document.createElement('p'), 'Meeting notes: acquire Acme for $4.2M')
    editor.appendChild(line)
    document.body.appendChild(editor)

    line.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(track).toHaveBeenCalledWith('click', expect.objectContaining({ tag: 'P', text: '' }))
  })

  it('redacts text when the element is marked data-pug-no-capture, keeping structural fields', () => {
    const track = vi.fn()
    cleanup = setupClickTracking(track)

    const btn = withText(document.createElement('button'), 'jane@example.com')
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
    const span = withText(document.createElement('span'), 'SSN 123-45-6789')
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
