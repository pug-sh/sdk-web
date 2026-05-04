import { describe, expect, it } from 'vitest'
import { makeStorageKey } from './utils.js'

describe('makeStorageKey', () => {
  it('formats key with dunder pattern', () => {
    expect(makeStorageKey('proj1', 'session')).toBe('__pug_proj1_session__')
  })

  it('handles special characters in projectId', () => {
    expect(makeStorageKey('my-project', 'queue')).toBe('__pug_my-project_queue__')
  })
})
