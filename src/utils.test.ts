import { afterEach, describe, expect, it } from 'vitest'
import { isCaptureSuppressed, makeStorageKey } from './utils.js'

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
