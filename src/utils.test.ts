import { afterEach, describe, expect, it } from 'vitest'
import { getSafeElementText, isCaptureSuppressed, makeStorageKey } from './utils.js'

describe('makeStorageKey', () => {
  it('formats key with dunder pattern', () => {
    expect(makeStorageKey('proj1', 'session')).toBe('__pug_proj1_session__')
  })

  it('handles special characters in projectId', () => {
    expect(makeStorageKey('my-project', 'queue')).toBe('__pug_my-project_queue__')
  })
})

describe('isCaptureSuppressed', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('returns false for null', () => {
    expect(isCaptureSuppressed(null)).toBe(false)
  })

  it('returns false for an unmarked element', () => {
    document.body.innerHTML = '<button id="b">Pay</button>'
    expect(isCaptureSuppressed(document.getElementById('b'))).toBe(false)
  })

  it('returns true when the element itself is marked', () => {
    document.body.innerHTML = '<button id="b" data-pug-no-capture>John Doe</button>'
    expect(isCaptureSuppressed(document.getElementById('b'))).toBe(true)
  })

  it('returns true when an ancestor is marked (covers everything inside it)', () => {
    document.body.innerHTML = '<div data-pug-no-capture><span><a id="inner">x@y.com</a></span></div>'
    expect(isCaptureSuppressed(document.getElementById('inner'))).toBe(true)
  })
})

describe('getSafeElementText', () => {
  const el = (html: string): Element => {
    document.body.innerHTML = html
    return document.getElementById('t') as Element
  }

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('returns empty for null', () => {
    expect(getSafeElementText(null, 50)).toBe('')
  })

  it('reads direct child text nodes, skipping descendant text', () => {
    expect(getSafeElementText(el('<div id="t">Order <span>jane@example.com</span> total</div>'), 50)).toBe(
      'Order total',
    )
  })

  it('returns empty when the element only wraps other elements', () => {
    expect(getSafeElementText(el('<div id="t"><span>4111 1111 1111 1111</span></div>'), 50)).toBe('')
  })

  it('truncates to maxLength after collapsing whitespace', () => {
    expect(getSafeElementText(el(`<div id="t">  a\n\n  b  </div>`), 3)).toBe('a b')
  })

  // The early bail must not change the result, only how much is concatenated first.
  it('truncates correctly past the internal bail threshold', () => {
    expect(getSafeElementText(el(`<div id="t">${'ab '.repeat(500)}</div>`), 5)).toBe('ab ab')
  })

  it('drops whitespace the truncation exposes', () => {
    expect(getSafeElementText(el('<div id="t">abcd <span>X</span>efg</div>'), 5)).toBe('abcd')
  })

  it('returns empty for a textarea', () => {
    document.body.innerHTML = '<textarea id="t">my private draft</textarea>'
    expect(getSafeElementText(document.getElementById('t') as Element, 50)).toBe('')
  })

  it('returns empty when the element itself is contenteditable', () => {
    expect(getSafeElementText(el('<div id="t" contenteditable="true">typed by the user</div>'), 50)).toBe('')
  })

  // contenteditable is inherited: editors put it on a root and the pointer lands on a descendant, so
  // reading the attribute off the target alone leaked the whole draft.
  it('returns empty when an ancestor is contenteditable', () => {
    expect(getSafeElementText(el('<div contenteditable="true"><p id="t">my secret diary entry</p></div>'), 50)).toBe('')
  })

  it('still captures inside a contenteditable="false" island', () => {
    expect(
      getSafeElementText(
        el('<div contenteditable="true"><span id="t" contenteditable="false">Static</span></div>'),
        50,
      ),
    ).toBe('Static')
  })

  it('treats contenteditable with no value as editable', () => {
    expect(getSafeElementText(el('<div contenteditable=""><p id="t">draft</p></div>'), 50)).toBe('')
  })
})
