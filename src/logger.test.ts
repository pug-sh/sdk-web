import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { log, setDebugLogging } from './logger.js'

describe('logger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    setDebugLogging(false)
    vi.restoreAllMocks()
  })

  it('suppresses debug output by default', () => {
    log.debug('should not appear')

    expect(console.debug).not.toHaveBeenCalled()
  })

  it('writes debug output once enabled, with the SDK prefix and extra args', () => {
    setDebugLogging(true)

    log.debug('a message', { detail: 1 })

    expect(console.debug).toHaveBeenCalledWith('[Pug SDK] a message', { detail: 1 })
  })

  it('suppresses debug output again when disabled', () => {
    setDebugLogging(true)
    log.debug('first')
    setDebugLogging(false)
    log.debug('second')

    expect(console.debug).toHaveBeenCalledOnce()
    expect(console.debug).toHaveBeenCalledWith('[Pug SDK] first')
  })

  it('always writes warnings and errors regardless of the debug flag', () => {
    log.warn('a warning')
    log.error('an error')

    expect(console.warn).toHaveBeenCalledWith('[Pug SDK] a warning')
    expect(console.error).toHaveBeenCalledWith('[Pug SDK] an error')
  })

  it('never throws when the host page has a console that throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console patched by the host page')
    })
    setDebugLogging(true)
    vi.spyOn(console, 'debug').mockImplementation(() => {
      throw new Error('console patched by the host page')
    })

    expect(() => log.warn('still safe')).not.toThrow()
    expect(() => log.debug('still safe')).not.toThrow()
  })
})
