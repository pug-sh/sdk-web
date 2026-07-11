// CDN entry — bundled by esbuild (scripts/build-cdn.mjs) into the IIFE served from jsDelivr as
// dist/cdn/pug.min.js. Installs the public API on `window.pug`, replays calls queued by the loader
// snippet, and auto-inits from data attributes for the one-tag install. Not part of the ESM
// package surface (unreachable via the exports map): importing the SDK stays side-effect free —
// only executing this file as a script installs the global.
import { autoInitFromScript, installPug, type PugStub, replayQueue, type StubMethod } from './cdn-install.js'
import {
  destroy,
  getTrackingConsent,
  identify,
  init,
  isTrackingEnabled,
  optInTracking,
  optOutTracking,
  reset,
  rotate,
  setAutoCapture,
  track,
} from './index.js'
import { log } from './logger.js'
import { SDK_VERSION } from './version.js'

// `satisfies` pins the api to STUB_METHODS exactly (missing or extra keys fail to compile), so the
// loader snippet's method list — checked against STUB_METHODS by the fixture test — cannot drift
// from what is actually installed.
const api = {
  init,
  track,
  identify,
  reset,
  destroy,
  setAutoCapture,
  optInTracking,
  optOutTracking,
  isTrackingEnabled,
  getTrackingConsent,
  rotate,
  /**
   * CDN-only helper: runs `cb` once the SDK is loaded — queued before load it fires during queue
   * replay at its queue position, after load it runs synchronously. Use it to read state
   * (`isTrackingEnabled()`) or await promises (`identify()`), since calls queued before load
   * return undefined instead of their real return value.
   */
  ready: (cb: () => void): void => {
    if (typeof cb !== 'function') {
      log.warn('ready() expects a function.')
      return
    }
    try {
      cb()
    } catch (err) {
      log.error('ready() callback failed:', err)
    }
  },
  version: SDK_VERSION,
} satisfies Record<StubMethod, (...args: never[]) => unknown> & { version: string }

if (typeof window !== 'undefined') {
  const installed = installPug(window as { pug?: PugStub }, api)
  if (installed) {
    const hasQueuedInit = installed.pending.some(call => Array.isArray(call) && call[0] === 'init')
    // Auto-init (one-tag install) runs before replay so queued track/consent calls land after
    // init instead of being dropped; an explicit queued init always beats data attributes.
    const autoInited = !hasQueuedInit && autoInitFromScript(document.currentScript, init)
    replayQueue(installed.pending, installed.dispatch, autoInited)
  }
}
