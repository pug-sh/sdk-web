import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  autoInitFromScript,
  type CdnApi,
  installPug,
  type PugStub,
  type QueuedCall,
  replayQueue,
  STUB_METHODS,
} from './cdn-install.js'

// vi.hoisted: this file imports cdn-install.js statically, so the vi.mock factory runs during the
// hoisted import phase — a plain const would not be initialized yet.
const logSpies = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('./logger.js', () => ({
  log: logSpies,
}))

const makeApi = (): CdnApi & { calls: string[] } => {
  const calls: string[] = []
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`${name}(${args.map(a => JSON.stringify(a)).join(',')})`)
    }
  return {
    calls,
    version: '1.2.3',
    init: record('init'),
    track: record('track'),
    identify: record('identify'),
    optOutTracking: record('optOutTracking'),
    ready: record('ready'),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('installPug', () => {
  it('installs a fresh global for bare script-tag loads', () => {
    const w: { pug?: PugStub } = {}
    const api = makeApi()

    const installed = installPug(w, api)

    expect(installed).not.toBeNull()
    expect(w.pug).toBeDefined()
    expect(w.pug?.init).toBe(api.init)
    expect(w.pug?.__loaded).toBe('1.2.3')
    expect(installed?.pending).toEqual([])
  })

  it('mutates the snippet stub in place so early object references stay live', () => {
    const stub: PugStub = { _q: [['track', ['early']]], _v: 1 }
    const w: { pug?: PugStub } = { pug: stub }
    const api = makeApi()

    const installed = installPug(w, api)

    expect(w.pug).toBe(stub) // same object identity
    expect(stub.track).toBe(api.track)
    expect(stub.__loaded).toBe('1.2.3')
    expect(installed?.pending).toEqual([['track', ['early']]])
    expect(stub._q).toHaveLength(0)
  })

  it('routes late pushes from captured stub methods to live dispatch', () => {
    const queue: QueuedCall[] = []
    const stub: PugStub = { _q: queue, _v: 1 }
    // Simulates a snippet stub method captured before load: it closes over the original array.
    const capturedTrack = (...args: unknown[]) => {
      queue.push(['track', args])
    }
    const w: { pug?: PugStub } = { pug: stub }
    const api = makeApi()

    installPug(w, api)
    capturedTrack('late', 42)

    expect(api.calls).toEqual(['track("late",42)'])
    expect(queue).toHaveLength(0) // dispatched, not parked
  })

  it('refuses to overwrite a foreign window.pug and leaves it untouched', () => {
    const foreign = { render: () => 'template engine' }
    const w: { pug?: PugStub } = { pug: foreign as unknown as PugStub }

    const installed = installPug(w, makeApi())

    expect(installed).toBeNull()
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('not the Pug loader stub'))
    expect(w.pug).toBe(foreign)
    expect(w.pug?.__loaded).toBeUndefined()
  })

  it('refuses a function-shaped foreign global (the real pug template runtime shape)', () => {
    const foreign = function render() {}
    const w: { pug?: PugStub } = { pug: foreign as unknown as PugStub }

    const installed = installPug(w, makeApi())

    expect(installed).toBeNull()
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('not the Pug loader stub'))
    expect(w.pug).toBe(foreign)
  })

  it('ignores a duplicate script load and keeps the first install', () => {
    const w: { pug?: PugStub } = {}
    const first = makeApi()
    const second = makeApi()

    installPug(w, first)
    const again = installPug(w, second)

    expect(again).toBeNull()
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('already loaded'))
    expect(w.pug?.init).toBe(first.init)
  })
})

describe('replayQueue', () => {
  it('replays strictly in FIFO order with arguments intact', () => {
    const api = makeApi()
    const installed = installPug({}, api)
    if (!installed) throw new Error('install failed')

    replayQueue(
      [
        ['init', ['pid', { apiKey: 'k' }]],
        ['optOutTracking', []],
        ['track', ['signup', { plan: 'pro' }]],
      ],
      installed.dispatch,
      false,
    )

    expect(api.calls).toEqual(['init("pid",{"apiKey":"k"})', 'optOutTracking()', 'track("signup",{"plan":"pro"})'])
  })

  it('isolates a throwing queued call and continues the replay', () => {
    const api = makeApi()
    api.init = () => {
      throw new Error('projectId is required')
    }
    const installed = installPug({}, api)
    if (!installed) throw new Error('install failed')

    replayQueue(
      [
        ['init', ['']],
        ['track', ['after']],
      ],
      installed.dispatch,
      false,
    )

    expect(logSpies.error).toHaveBeenCalledWith(expect.stringContaining('Queued init() call failed'), expect.any(Error))
    expect(api.calls).toEqual(['track("after")'])
  })

  it('logs the rejection of a promise-returning queued call instead of leaving it unhandled', async () => {
    const api = makeApi()
    api.identify = () => Promise.reject(new Error('rpc down'))
    const installed = installPug({}, api)
    if (!installed) throw new Error('install failed')

    replayQueue([['identify', ['user@example.com']]], installed.dispatch, true)

    await vi.waitFor(() => {
      expect(logSpies.error).toHaveBeenCalledWith(
        expect.stringContaining('Queued identify() call rejected'),
        expect.any(Error),
      )
    })
  })

  it('warns and skips queued calls to unknown methods', () => {
    const api = makeApi()
    const installed = installPug({}, api)
    if (!installed) throw new Error('install failed')

    replayQueue(
      [
        ['nope', []],
        ['track', ['x']],
      ],
      installed.dispatch,
      true,
    )

    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('unknown method "nope"'))
    expect(api.calls).toEqual(['track("x")'])
  })

  it('rejects inherited prototype members instead of invoking them', () => {
    const api = makeApi()
    const installed = installPug({}, api)
    if (!installed) throw new Error('install failed')

    // Object.prototype members resolve to functions via the prototype chain; dispatch must fail
    // closed on them rather than call constructor()/toString()/hasOwnProperty().
    replayQueue(
      [
        ['constructor', []],
        ['toString', []],
        ['hasOwnProperty', ['x']],
        ['track', ['x']],
      ],
      installed.dispatch,
      true,
    )

    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('unknown method "constructor"'))
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('unknown method "toString"'))
    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('unknown method "hasOwnProperty"'))
    expect(api.calls).toEqual(['track("x")'])
  })

  it('warns on malformed queue entries and keeps replaying', () => {
    const api = makeApi()
    const installed = installPug({}, api)
    if (!installed) throw new Error('install failed')

    replayQueue(['init' as unknown as QueuedCall, ['track', ['x']]], installed.dispatch, true)

    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('malformed queue entry'), 'init')
    expect(api.calls).toEqual(['track("x")'])
  })

  it('warns once about calls queued before init and still replays everything in order', () => {
    const api = makeApi()
    const installed = installPug({}, api)
    if (!installed) throw new Error('install failed')

    replayQueue(
      [
        ['ready', []], // exempt — does not depend on init
        ['track', ['dropped-1']],
        ['optOutTracking', []],
        ['init', ['pid', { apiKey: 'k' }]],
        ['track', ['kept']],
      ],
      installed.dispatch,
      false,
    )

    const aggregate = logSpies.warn.mock.calls.filter(call => String(call[0]).includes('queued before pug.init()'))
    expect(aggregate).toHaveLength(1)
    expect(aggregate[0][0]).toContain('2 call(s) were queued before pug.init()')
    expect(aggregate[0][0]).toContain('track(), optOutTracking()')
    // The consent-critical invariant: replay is strict FIFO — init is NOT hoisted ahead of the
    // calls queued before it (hoisting would fire an autocapture page_view past a queued opt-out).
    expect(api.calls).toEqual([
      'ready()',
      'track("dropped-1")',
      'optOutTracking()',
      'init("pid",{"apiKey":"k"})',
      'track("kept")',
    ])
  })

  it('warns when the queue contains no init at all', () => {
    const api = makeApi()
    const installed = installPug({}, api)
    if (!installed) throw new Error('install failed')

    replayQueue(
      [
        ['track', ['x']],
        ['optOutTracking', []],
      ],
      installed.dispatch,
      false,
    )

    expect(logSpies.warn).toHaveBeenCalledWith(expect.stringContaining('2 call(s) were queued before pug.init()'))
  })

  it('does not warn when init comes first or when auto-init already ran', () => {
    const api = makeApi()
    const installed = installPug({}, api)
    if (!installed) throw new Error('install failed')

    replayQueue(
      [
        ['init', ['pid', { apiKey: 'k' }]],
        ['track', ['x']],
      ],
      installed.dispatch,
      false,
    )
    replayQueue([['track', ['y']]], installed.dispatch, true) // auto-init case

    expect(logSpies.warn).not.toHaveBeenCalled()
  })
})

describe('autoInitFromScript', () => {
  const makeScript = (attrs: Record<string, string>): HTMLScriptElement => {
    const el = document.createElement('script')
    for (const [name, value] of Object.entries(attrs)) {
      el.setAttribute(name, value)
    }
    return el
  }

  it('initializes from data-project-id and data-api-key', () => {
    const initFn = vi.fn()

    const ran = autoInitFromScript(makeScript({ 'data-project-id': 'pid', 'data-api-key': 'k' }), initFn)

    expect(ran).toBe(true)
    expect(initFn).toHaveBeenCalledWith('pid', { apiKey: 'k' })
  })

  it('merges data-options JSON with flat attributes winning', () => {
    const initFn = vi.fn()
    const script = makeScript({
      'data-project-id': 'pid',
      'data-api-key': 'flat-key',
      'data-endpoint': 'https://flat.example',
      'data-options': '{"dryRun":true,"apiKey":"json-key","endpoint":"https://json.example"}',
    })

    const ran = autoInitFromScript(script, initFn)

    expect(ran).toBe(true)
    expect(initFn).toHaveBeenCalledWith('pid', { apiKey: 'flat-key', endpoint: 'https://flat.example', dryRun: true })
  })

  it('treats an empty data-endpoint as absent, so a data-options endpoint applies', () => {
    const initFn = vi.fn()
    const script = makeScript({
      'data-project-id': 'pid',
      'data-api-key': 'k',
      'data-endpoint': '',
      'data-options': '{"endpoint":"https://json.example"}',
    })

    autoInitFromScript(script, initFn)

    expect(initFn).toHaveBeenCalledWith('pid', { apiKey: 'k', endpoint: 'https://json.example' })
  })

  it('requires both id attributes and fails closed when one is missing', () => {
    const initFn = vi.fn()

    expect(autoInitFromScript(makeScript({ 'data-project-id': 'pid' }), initFn)).toBe(false)
    expect(autoInitFromScript(makeScript({ 'data-api-key': 'k' }), initFn)).toBe(false)

    expect(initFn).not.toHaveBeenCalled()
    expect(logSpies.error).toHaveBeenCalledTimes(2)
  })

  it('treats present-but-empty attributes as a broken one-tag install, loudly', () => {
    const initFn = vi.fn()

    // e.g. a failed server-side template interpolation renders data-project-id="" data-api-key=""
    const ran = autoInitFromScript(makeScript({ 'data-project-id': '', 'data-api-key': '' }), initFn)

    expect(ran).toBe(false)
    expect(initFn).not.toHaveBeenCalled()
    expect(logSpies.error).toHaveBeenCalledWith(expect.stringContaining('missing/empty: data-project-id, data-api-key'))
  })

  it('errors when only data-options is present — one-tag intent without credentials', () => {
    const initFn = vi.fn()

    const ran = autoInitFromScript(makeScript({ 'data-options': '{"dryRun":true}' }), initFn)

    expect(ran).toBe(false)
    expect(initFn).not.toHaveBeenCalled()
    expect(logSpies.error).toHaveBeenCalledWith(expect.stringContaining('missing/empty'))
  })

  it('stays silent when no auto-init attributes are present', () => {
    const initFn = vi.fn()

    expect(autoInitFromScript(makeScript({}), initFn)).toBe(false)
    expect(autoInitFromScript(null, initFn)).toBe(false)

    expect(initFn).not.toHaveBeenCalled()
    expect(logSpies.error).not.toHaveBeenCalled()
  })

  it('fails closed on malformed data-options instead of initializing with half a config', () => {
    const initFn = vi.fn()
    const base = { 'data-project-id': 'pid', 'data-api-key': 'k' }

    expect(autoInitFromScript(makeScript({ ...base, 'data-options': '{not json' }), initFn)).toBe(false)
    expect(autoInitFromScript(makeScript({ ...base, 'data-options': '[1,2]' }), initFn)).toBe(false)
    expect(autoInitFromScript(makeScript({ ...base, 'data-options': 'null' }), initFn)).toBe(false)

    expect(initFn).not.toHaveBeenCalled()
    expect(logSpies.error).toHaveBeenCalledTimes(3)
  })

  it('contains a throwing init and reports failure', () => {
    const initFn = vi.fn(() => {
      throw new Error('apiKey is required')
    })

    const ran = autoInitFromScript(makeScript({ 'data-project-id': 'pid', 'data-api-key': 'k' }), initFn)

    expect(ran).toBe(false)
    expect(logSpies.error).toHaveBeenCalledWith('Auto-init failed:', expect.any(Error))
  })
})

describe('loader snippet fixture', () => {
  const SNIPPET_RE = /!\(function \(w, d\) \{[\s\S]*?\}\)\(window, document\);/g

  const readDoc = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

  const extractSnippet = (path: string): string => {
    const matches = [...readDoc(path).matchAll(SNIPPET_RE)].map(m => m[0])
    expect(matches, `expected exactly one loader snippet in ${path}`).toHaveLength(1)
    return matches[0]
  }

  interface FakeScriptEl {
    async?: boolean
    src?: string
    onerror?: unknown
  }

  const makeFakeDocument = () => {
    const created: FakeScriptEl[] = []
    const appended: FakeScriptEl[] = []
    return {
      created,
      appended,
      createElement(_tag: string): FakeScriptEl {
        const el: FakeScriptEl = {}
        created.push(el)
        return el
      },
      head: {
        appendChild(el: FakeScriptEl): void {
          appended.push(el)
        },
      },
    }
  }

  const runSnippetOnFreshPage = () => {
    const fakeDoc = makeFakeDocument()
    const w: { pug?: PugStub } = {}
    const runSnippet = new Function('window', 'document', extractSnippet('../README.md'))
    runSnippet(w, fakeDoc)
    return { fakeDoc, w, runSnippet }
  }

  it('every documented exact-pin URL matches the package.json version', () => {
    const { version } = JSON.parse(readDoc('../package.json')) as { version: string }
    for (const path of ['../README.md']) {
      const pins = [...readDoc(path).matchAll(/cdn\.pugs\.dev\/v(\d+\.\d+\.\d+)\/pug\.min\.js/g)].map(m => m[1])
      expect(pins.length, `expected at least one pinned URL in ${path}`).toBeGreaterThan(0)
      for (const pin of pins) {
        // RELEASING.md step: bump the pinned snippet URLs together with the version.
        expect(pin, `pinned URL in ${path}`).toBe(version)
      }
    }
  })

  it('the documented snippet builds a working stub that the bundle can install over', () => {
    const { fakeDoc, w, runSnippet } = runSnippetOnFreshPage()

    // Stub shape the bundle relies on: exactly the STUB_METHODS plus queue bookkeeping.
    const stub = w.pug
    if (!stub) throw new Error('snippet did not set window.pug')
    expect(stub._v).toBe(1)
    expect(Array.isArray(stub._q)).toBe(true)
    for (const method of STUB_METHODS) {
      expect(typeof stub[method], `stub.${method}`).toBe('function')
    }
    expect(Object.keys(stub).sort()).toEqual([...STUB_METHODS, '_q', '_v'].sort())

    // It injects one async script pointing at the versioned CDN bundle, with a load-failure breadcrumb.
    expect(fakeDoc.appended).toHaveLength(1)
    expect(fakeDoc.appended[0].async).toBe(true)
    expect(fakeDoc.appended[0].src).toMatch(/^https:\/\/cdn\.pugs\.dev\/v\d+\.\d+\.\d+\/pug\.min\.js$/)
    expect(typeof fakeDoc.appended[0].onerror).toBe('function')

    // Re-running the snippet (double paste) is a no-op.
    runSnippet(w, fakeDoc)
    expect(fakeDoc.appended).toHaveLength(1)

    // Calls queue as [method, realArgsArray], and the bundle replays them in order.
    const stubInit = stub.init as (...args: unknown[]) => void
    const stubTrack = stub.track as (...args: unknown[]) => void
    stubInit('pid', { apiKey: 'k' })
    stubTrack('signup', { plan: 'pro' })
    expect(stub._q).toEqual([
      ['init', ['pid', { apiKey: 'k' }]],
      ['track', ['signup', { plan: 'pro' }]],
    ])

    const api = makeApi()
    const installed = installPug(w, api)
    if (!installed) throw new Error('install failed')
    replayQueue(installed.pending, installed.dispatch, false)
    expect(api.calls).toEqual(['init("pid",{"apiKey":"k"})', 'track("signup",{"plan":"pro"})'])

    // A stub method captured before load keeps working after it.
    stubTrack('late')
    expect(api.calls).toContain('track("late")')
  })

  it('the example harness embeds the canonical snippet (only src differs)', () => {
    const canonical = extractSnippet('../README.md')
    const example = extractSnippet('../examples/cdn/index.html')
    const normalize = (snippet: string): string =>
      snippet
        .split('\n')
        .map(line => line.trim())
        .join('\n')
        .replace(/s\.src = '[^']+';/, "s.src = '<src>';")

    expect(normalize(example)).toBe(normalize(canonical))
  })

  it('warns and leaves a pre-existing foreign window.pug untouched (no clobber, no load)', () => {
    // A real foreign global already on the page (e.g. the pug template engine). On a `window.pug`
    // that is not our loader stub (no `_q`), the snippet warns and bails: it must never overwrite an
    // unrelated global, so it writes no stub and injects no bundle script. The trailing `pug.init(...)`
    // (outside SNIPPET_RE) still reaches the foreign object, but the branded warning names the cause.
    // installPug's foreign-global guard (see "refuses to overwrite a foreign window.pug" above) is the
    // matching net on the one-tag / direct-bundle-load path where no snippet runs first.
    const foreign = { render: () => 'template engine' }
    const fakeDoc = makeFakeDocument()
    const w: { pug?: PugStub } = { pug: foreign as unknown as PugStub }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runSnippet = new Function('window', 'document', extractSnippet('../README.md'))

    runSnippet(w, fakeDoc)

    expect(w.pug).toBe(foreign) // untouched — the snippet wrote no stub over it
    expect(fakeDoc.appended).toHaveLength(0) // and never injected the bundle script
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[Pug SDK]'))
    warn.mockRestore()
  })

  it('caps the queue at 1000 entries when the bundle never arrives', () => {
    const { w } = runSnippetOnFreshPage()
    const stubTrack = w.pug?.track as (...args: unknown[]) => void

    for (let i = 0; i < 1005; i++) {
      stubTrack(`event-${i}`)
    }

    expect(w.pug?._q).toHaveLength(1000)
  })
})
