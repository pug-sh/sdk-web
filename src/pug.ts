import { create } from '@bufbuild/protobuf'
import {
  type AutoCaptureConfig,
  type AutoCaptureController,
  type AutoCaptureSelection,
  createAutoCaptureController,
} from './auto-capture.js'
import { type BatchConfig, createBatchedTransport } from './batch.js'
import { type CrossSubdomainConfig, createCookieLayer } from './cookie.js'
import { IdentifyRequestSchema, ProfilesSDKService } from './gen/sdk/profiles/v1/profiles_pb.js'
import { log, setDebugLogging } from './logger.js'
import { initUserAgentData } from './parsers.js'
import { createPersistentStore, type PersistentStore } from './persistence.js'
import {
  clearProfile,
  configureProfile,
  destroyProfile,
  getAnonymousId,
  isIdentified,
  markIdentified,
  resolveDistinctId,
} from './profile.js'
import { ONE_SHOT_TIMEOUT_MS, unaryCall } from './rpc.js'
import {
  clearSession,
  configureSession,
  destroySession,
  onConsentGranted,
  resetIdentity,
  resolveSessionId,
  type SessionConfig,
} from './session.js'
import {
  type BeforeSendFn,
  configureBeforeSend,
  type EventIdentity,
  type JsonValue,
  type TrackFn,
  type TrackOptions,
  toEvent,
} from './track.js'
import {
  createTrackingConsent,
  type RejectConsent,
  type TrackingConsent,
  type TrackingConsentConfig,
  type TrackingConsentController,
} from './tracking-consent.js'
import { DEFAULT_ENDPOINT, DEVICE_ID_KEY, RESERVED_DISTINCT_ID_PREFIX } from './utils.js'

export interface PugConfig {
  readonly endpoint: string
  readonly projectId: string
}

export interface InitOptions {
  readonly endpoint?: string
  readonly apiKey: string
  readonly batch?: Partial<BatchConfig>
  readonly dryRun?: boolean
  /**
   * Logs the SDK's internal activity to `console.debug`. Off by default.
   *
   * Turn it on when events are not arriving: it reports each `track()` call, the drops this flag
   * governs (denied consent and `dryRun`), and whether auto-capture ended up with any trackers
   * active. Note that `console.debug` output sits in DevTools' "Verbose" level, which is hidden
   * until you enable it in the console's level filter.
   *
   * The drops this flag does *not* govern are the ones you never want hidden, so they are reported
   * regardless: a call before `init()` and a bad config warn, and an event too malformed to encode
   * errors. This flag can only widen what you see, never narrow it.
   */
  readonly debug?: boolean
  readonly session?: SessionConfig
  readonly autoCapture?: AutoCaptureConfig
  readonly trackingConsent?: TrackingConsent | TrackingConsentConfig
  /**
   * Shares identity (anonymous ID, external ID, session state, persisted consent) across subdomains
   * of the same site via a first-party cookie on the registrable domain (e.g. `.example.com`).
   *
   * **Off by default.** Cross-subdomain identity trades browser-enforced same-origin isolation for
   * the weaker same-site trust model, so it must be a conscious opt-in per integrator — see
   * `docs/cross-domain-tracking-threat-model.md` in the backend `pug` repo.
   *
   * - `false` (default) — origin-scoped `localStorage` only; no shared cookie.
   * - `true` — discover the widest settable domain (eTLD+1) with a write-probe. Degrades to a
   *   host-only cookie on localhost and IP hosts, and to `localStorage` when cookies are blocked.
   *   Cookies set from an HTTPS page carry `Secure`, so identity is shared only among HTTPS
   *   subdomains — an HTTP subdomain cannot read them. ⚠️ On a custom multi-tenant registrable
   *   domain that is not on the Public Suffix List (e.g. `tenant-a.myplatform.com` and
   *   `tenant-b.myplatform.com` run as separate customers), the probe returns the shared
   *   `myplatform.com`, letting sibling tenants read and overwrite each other's identity. Prefer
   *   an explicit `{ domain }` in that topology.
   * - `{ domain }` — pin an explicit cookie domain (falls back to a host-only cookie with a warning
   *   when the browser rejects it or it does not cover the current host).
   * - `{ maxAgeDays }` — cookie lifetime in days, default 365. Omit `domain` to keep auto-discovery.
   *
   * With cross-subdomain sessions, the "rotate when all tabs closed" heuristic is disabled — sessions
   * end by idle/max timeout only, since tab liveness is unknowable across subdomains.
   */
  readonly crossSubdomainTracking?: CrossSubdomainConfig
  /**
   * Redacts, rewrites or drops each event before it is sent. Mutate `autoProperties` /
   * `customProperties` in place and return the event, `null` to drop it, or nothing at all.
   * `$url`, `$referrer` and a form's `action` arrive raw — masking them is this hook's job.
   *
   * Runs synchronously on every event, so keep it cheap. Fails closed: a throw, a malformed return
   * or a non-function value drops the event (or every event) rather than sending it unredacted.
   * `$projectId`/`$platform`/`$sdkVersion` are re-asserted afterwards; `sessionId`/`distinctId` are
   * not exposed. Unavailable on the one-tag install — `data-options` is JSON, which holds no
   * functions.
   */
  readonly beforeSend?: BeforeSendFn
}

export type {
  AutoCaptureConfig,
  AutoCaptureSelection,
  CrossSubdomainConfig,
  RejectConsent,
  TrackingConsent,
  TrackingConsentConfig,
}

interface PugState {
  readonly config: PugConfig
  readonly transport: ReturnType<typeof createBatchedTransport>
  readonly apiKey: string
  readonly dryRun: boolean
  readonly autoCapture: AutoCaptureController
  readonly trackingConsent: TrackingConsentController
}

let state: PugState | null = null

// One-shot so a cookieless site calling identify() on every page doesn't spam the console.
let cookielessIdentifyWarned = false

/**
 * Compile-time exhaustiveness marker. Reaching it with a non-`never` argument is a type error at the
 * call site, so widening a union forces every dispatch over it to be revisited.
 *
 * Deliberately does NOT throw, unlike the usual `assertNever` — but not because a throw could
 * escape: the only call site is inside `track()`'s outer try/catch, which would swallow and log it.
 * The reason is diagnostic quality. The caller's own `else` branch already fails closed and logs the
 * offending state by name; throwing here would replace that precise message with a generic
 * "Unexpected error in track()" and lose the one detail worth having. This only moves the diagnosis
 * to compile time.
 */
const unreachable = (_state: never): void => {}

export const init = (projectId: string, options: InitOptions) => {
  if (typeof window === 'undefined') {
    log.warn('init() called in a non-browser environment, skipping.')
    return
  }

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('[Pug SDK] projectId is required and must be a non-empty string')
  }

  if (!options.apiKey || typeof options.apiKey !== 'string') {
    throw new Error('[Pug SDK] apiKey is required and must be a non-empty string')
  }

  if (state) {
    log.warn('Already initialized.')
    return
  }

  // Before any other setup, so init's own debug output is captured too.
  setDebugLogging(options.debug ?? false)

  const config: PugConfig = { endpoint: options.endpoint || DEFAULT_ENDPOINT, projectId }

  let store: PersistentStore | null = null
  try {
    store = createPersistentStore(createCookieLayer(options.crossSubdomainTracking ?? false))
  } catch (err) {
    log.warn('Failed to initialize persistence:', err)
  }

  // Create consent before configuring identity so the init-time expiry refresh in configureProfile
  // is gated on it — no identity cookie write while consent is denied (constraint #6 of the
  // cross-domain threat model, which lives in the backend `pug` repo).
  const trackingConsent = createTrackingConsent(projectId, options.trackingConsent, store)

  try {
    configureSession(projectId, options.session, store, trackingConsent.isGranted)
  } catch (err) {
    log.warn('Failed to configure session tracking:', err)
  }

  try {
    configureProfile(projectId, store, trackingConsent.isGranted)
  } catch (err) {
    log.warn('Failed to configure profile:', err)
  }

  try {
    initUserAgentData()
  } catch (err) {
    log.warn('Failed to initialize user agent data:', err)
  }

  // No compiler protects a JS or one-tag install, and a silently ignored sanitizer means URLs the
  // integrator believes are masked start going out raw.
  if ('sanitizeUrl' in options) {
    log.warn('sanitizeUrl was removed and is ignored; URLs are now sent raw. Use beforeSend instead.')
  }
  configureBeforeSend(options.beforeSend)

  const transport = createBatchedTransport(config.endpoint, options.apiKey, projectId, options.batch)
  const autoCapture = createAutoCaptureController(track, trackingConsent.isTracking)

  state = {
    config,
    transport,
    apiKey: options.apiKey,
    dryRun: options.dryRun ?? false,
    autoCapture,
    trackingConsent,
  }

  if (state.dryRun) {
    log.warn('Dry run mode enabled — events will not be sent.')
  }
  if (state.trackingConsent.getConsent() === 'denied') {
    log.warn(
      'Tracking consent is denied — automatic capture is off and track()/identify() are dropped until optInTracking() is called. Check isTrackingEnabled() to detect this state.',
    )
  }
  if (state.trackingConsent.getConsent() === 'cookieless') {
    log.debug('Cookieless mode: events flow without stored identity; identify() is disabled until consent is granted.')
  }

  // Entering a non-granted state via config must leave the device in the same condition as entering
  // it via setTrackingConsent(), or a visitor whose CMP now says "reject" keeps a prior consented
  // visit's 365-day identifiers — and the documented "granting later mints a fresh identity" breaks,
  // since a later grant would resolve the *pre-existing* session and anonymous ID.
  //
  // Gated on isAuthoritative() so this only fires when consent is persisted and the resolved state
  // is therefore the user's own recorded choice. Without persistence the initial value is whatever
  // the caller passed on this load — for an async CMP typically a placeholder 'denied' corrected by
  // a later optInTracking() — and purging on that would mint a new identity on every page load.
  if (!state.trackingConsent.isGranted()) {
    // Unconditional, unlike the identity purge below: the queue is an outbound buffer of events
    // already collected, not an identifier a later grant could resolve. Withholding it here left a
    // prior consented visit's identified payloads on the device for every non-authoritative
    // non-granted init — the bare-string form the README's CMP recipe produces — to be transmitted
    // on the next pagehide while consent read 'denied', and re-persisted while it read 'cookieless'.
    purgeQueuedEvents()

    if (state.trackingConsent.isAuthoritative()) {
      // init() returns void, so this outcome has nowhere structured to go — but it must not be
      // inferred from the individual per-key errors either. A purge that did not land means a later
      // optInTracking() resolves the PRE-EXISTING identity, quietly falsifying the documented
      // "granting later mints a fresh identity", while getTrackingConsent() reports the new state as
      // though it fully applied. Name that consequence once, at the point it becomes true.
      if (!purgePersistedIdentity()) {
        log.error(
          'Could not fully remove stored identity for a non-granted consent state. Identifiers may survive on this device, and granting consent later may resume the previous identity rather than minting a fresh one.',
        )
      }
    } else {
      // Deliberately skipped — see isAuthoritative(). Say so, or an integrator passing a bare
      // 'cookieless'/'denied' has no way to tell the documented purge did not run and that a prior
      // visit's identifiers are still present (inert, but there).
      log.debug(
        'Consent is not granted but was not restored from storage, so it is a config seed rather than a recorded choice — stored identity was left in place. Use trackingConsent.persist to record the choice.',
      )
    }
  }

  state.autoCapture.setDesired(options.autoCapture)

  log.debug('Initialized.')
}

export const setAutoCapture = (autoCapture: AutoCaptureConfig): void => {
  if (!state) {
    log.warn('setAutoCapture() called before init().')
    return
  }
  state.autoCapture.setDesired(autoCapture)
  // isTracking, not isGranted: the controller attaches listeners whenever events flow, which
  // includes cookieless. Keying this on full consent printed "activate after opt-in" in cookieless
  // mode, where they had already activated — the exact conflation the predicate split prevents.
  if (!state.trackingConsent.isTracking()) {
    log.debug('setAutoCapture() stored selection; listeners activate after opt-in.')
  }
}

/**
 * Drops every persisted identifier: anonymous ID, external ID, session, and the tab registry —
 * including the shared cookie in cross-subdomain mode, so the purge propagates to sibling
 * subdomains. Returns false when any removal could not be confirmed, which in cross-subdomain
 * mode means an identity cookie survived on the registrable domain and will resurface.
 *
 * Idempotent in end state but not side-effect-free: it issues removals (cookie deletions when
 * cross-subdomain) and may log an error on an unconfirmed removal even when nothing was stored.
 */
/**
 * Drops the queued events: one best-effort send of what was collected under valid consent, then
 * both queues off the device.
 *
 * Split out from the identity purge because the two answer to different gates. The queue is an
 * **outbound buffer**, not an identifier anything reads back — purging it can never mint a new
 * identity, so `isAuthoritative()`'s reasoning (don't destroy identity on the strength of a
 * pre-banner seed) does not transfer to it. Folding the two together gave the queue that gate and
 * left a prior consented visit's identified payloads on the device through any non-authoritative
 * non-granted init, to be transmitted on the next pagehide and re-persisted while cookieless.
 */
const purgeQueuedEvents = (): boolean => {
  // A null state means the transport was never built, so the queue was not purged. Report that
  // rather than defaulting to success inside a privacy teardown.
  if (!state) {
    return false
  }
  try {
    if (state.transport.purgeQueue()) {
      return true
    }
    // The only teardown leg that could fail with no diagnostic at all: the queue's own purge()
    // returns false without logging when removeItem no-ops (a Storage shim, an extension proxy, a
    // quota-locked store). Both sibling legs log internally; this one has to be logged here.
    log.error(
      'Failed to drop the persisted event queue — queued events carry sessionId and distinctId, and may be sent on a later visit.',
    )
    return false
  } catch (err) {
    log.error('Failed to purge queued events:', err)
    return false
  }
}

const purgePersistedIdentity = (): boolean => {
  // Runs first, while those events still exist.
  let purged = purgeQueuedEvents()
  try {
    purged = clearProfile() && purged
  } catch (err) {
    log.error('Failed to clear profile:', err)
    purged = false
  }
  try {
    purged = clearSession() && purged
  } catch (err) {
    log.error('Failed to clear session:', err)
    purged = false
  }
  return purged
}

/**
 * Sets the tracking consent state — the general form of optInTracking()/optOutTracking(),
 * covering the third state: 'cookieless' keeps events flowing with a server-derived,
 * daily-rotating anonymous identity and writes no identifiers to the device.
 *
 * Leaving 'granted' purges persisted identity (profile + session + tab registry, including the
 * cross-subdomain cookie) — no identifier may linger for a user who withdrew consent.
 * Granting later mints a fresh identity lazily on the next event; pre-consent events
 * stay permanently anonymous (no retroactive linking).
 *
 * Returns **false** when the change did not fully take effect: it was called before `init()` (in
 * which case nothing happened at all), the value was not a valid consent state (consent then fails
 * closed to `'denied'`, matching init()), the choice could not be persisted (so it will not survive
 * a reload), or a persisted identifier could not be removed.
 *
 * Once `init()` has run, a valid state is always applied in memory, so `false` then means "applied,
 * but not fully durable" rather than "ignored" — and a caller acting on a withdrawal should surface
 * it rather than assume the device is clean. Before `init()` it does mean ignored, which is the case
 * a consent banner racing initialization is most likely to hit.
 */
export const setTrackingConsent = (consent: TrackingConsent): boolean => {
  if (!state) {
    log.warn('setTrackingConsent() called before init().')
    return false
  }
  let ok = state.trackingConsent.set(consent)
  const resolved = state.trackingConsent.getConsent()
  state.autoCapture.apply()
  if (resolved === 'granted') {
    // Re-arm the origin-local tab-liveness registry, which configureSession() skipped while consent
    // withheld it. Without this the "all tabs closed → rotate" heuristic stays dead for the rest of
    // the page's life — and under the consent-first flow the README recommends, init() always runs
    // before the banner is answered, so it would never arm at all.
    try {
      onConsentGranted()
    } catch (err) {
      log.warn('Failed to re-arm tab tracking after consent was granted:', err)
    }
  } else {
    // Required when leaving 'granted'. From another non-granted state it is a no-op in end state,
    // though not free: it still issues removals and may log on an unconfirmed one.
    ok = purgePersistedIdentity() && ok
  }
  log.debug(`Tracking consent set to "${resolved}".`)
  return ok
}

export const optInTracking = (): boolean => {
  if (!state) {
    // Guarded so the warning names this function rather than setTrackingConsent, matching optOut.
    log.warn('optInTracking() called before init().')
    return false
  }
  return setTrackingConsent('granted')
}

/**
 * Applies the rejection state: `'denied'`, or `trackingConsent.onReject` when configured — pass
 * `onReject: 'cookieless'` and the banner's reject branch keeps identity-free traffic counts without
 * naming the state itself. Either way persisted identity is torn down (see setTrackingConsent);
 * consent stays persisted so the rejection survives reloads.
 */
export const optOutTracking = (): boolean => {
  if (!state) {
    log.warn('optOutTracking() called before init().')
    return false
  }
  return setTrackingConsent(state.trackingConsent.getRejectState())
}

/**
 * Whether events are being tracked right now. Reflects tracking consent only — independent of
 * `dryRun`, which suppresses delivery without changing consent. `false` before `init()` is accurate
 * rather than a placeholder: nothing is being tracked yet.
 *
 * To read the user's *recorded choice* instead — which may be a persisted `'granted'` that this
 * returns `false` for simply because `init()` has not run — use `getTrackingConsent()` **after
 * `init()`**. Before then neither getter can see a persisted choice: it is only read from storage
 * during `init()`, so `getTrackingConsent()` answers `undefined` rather than guessing.
 */
export const isTrackingEnabled = (): boolean => {
  if (!state) {
    log.warn('isTrackingEnabled() called before init().')
    return false
  }
  // True whenever events flow — full consent OR cookieless mode. Use
  // getTrackingConsent() to distinguish the two.
  return state.trackingConsent.isTracking()
}

/**
 * The user's recorded consent choice, or `undefined` before `init()`.
 *
 * A persisted choice is only read from storage during `init()`, so before then there is genuinely no
 * answer to give. It reports `undefined` rather than `'denied'` because those mean different things:
 * a consent banner gated on a pre-init `'denied'` would prompt a user who had already opted in.
 */
export const getTrackingConsent = (): TrackingConsent | undefined => {
  if (!state) {
    log.warn(
      'getTrackingConsent() called before init(); returning undefined — a persisted choice is only read during init().',
    )
    return undefined
  }
  return state.trackingConsent.getConsent()
}

/**
 * Whether the user has yet to make a choice — the banner gate.
 *
 * `getTrackingConsent()` reports the state the SDK is *acting on*, which before any answer is the
 * `trackingConsent.initial` seed, so a seeded `'granted'` and a chosen `'granted'` read identically
 * and a banner keyed on it re-prompts users who already opted in.
 *
 * `true` before `init()`: nothing has been read from storage yet, so no choice is known.
 */
export const isConsentPending = (): boolean => {
  if (!state) {
    log.warn('isConsentPending() called before init(); returning true — a persisted choice is only read during init().')
    return true
  }
  return state.trackingConsent.isPending()
}

export const destroy = () => {
  if (typeof window === 'undefined') {
    return
  }

  if (!state) {
    log.warn('destroy() called but SDK is not initialized.')
    return
  }

  state.autoCapture.destroy()

  try {
    state.transport.destroy()
  } catch (err) {
    log.error('Error during transport destroy:', err)
  }

  destroySession()
  destroyProfile()
  configureBeforeSend(undefined)
  setDebugLogging(false)

  cookielessIdentifyWarned = false
  state = null
}

export const reset = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  if (!state) {
    log.warn('reset() called but SDK is not initialized.')
    return false
  }
  let ok = true
  try {
    // Aggregated, not merely called: resetIdentity()'s failure arms log and return rather than
    // throwing, so a catch-only guard reported success while the previous user's session and device
    // id were still on the device.
    ok = resetIdentity() && ok
  } catch (err) {
    log.error('Failed to reset identity:', err)
    ok = false
  }
  // The queue holds the outgoing user's events, and after identify() their distinctId is that user's
  // externalId — on a shared device the next person must not inherit them. purgeQueue() makes one
  // best-effort send first, so events collected while they were signed in are not simply discarded.
  try {
    if (!state.transport.purgeQueue()) {
      ok = false
    }
  } catch (err) {
    log.error('Failed to purge queued events:', err)
    ok = false
  }
  try {
    ok = clearProfile() && ok
  } catch (err) {
    log.error('Failed to clear profile:', err)
    ok = false
  }
  return ok
}

/**
 * Never throws — invalid input, calls before init(), denied consent, dryRun, and RPC failures are
 * logged and the promise resolves without sending. Callers may await it without their own try/catch.
 * On first identify, includes anonymousId (for profile merge) and, if available, deviceId (for push device linking).
 */
export const identify = async (externalId: string, traits?: Record<string, JsonValue>): Promise<void> => {
  try {
    if (typeof window === 'undefined') {
      log.warn('identify() called in a non-browser environment, skipping.')
      return
    }
    if (!state) {
      log.warn('identify() called before init().')
      return
    }
    if (!externalId || typeof externalId !== 'string') {
      log.error('identify() requires a non-empty externalId string.')
      return
    }
    // The server reserves this prefix for the ids it derives for cookieless events, and enforces it
    // with a message-level CEL rule over the whole BatchCreateRequest. Accepting one here would
    // persist it as the externalId, making it the distinctId on every later event — so every batch
    // containing this user would be rejected wholesale (InvalidArgument, classified permanent, so
    // the batch is committed and dropped) with nothing pointing back at the identify() that did it.
    if (externalId.startsWith(RESERVED_DISTINCT_ID_PREFIX)) {
      log.error(
        `identify() rejected: externalId must not start with the reserved "${RESERVED_DISTINCT_ID_PREFIX}" prefix, which the server uses for cookieless identities.`,
      )
      return
    }
    if (!state.trackingConsent.isGranted()) {
      if (state.trackingConsent.getConsent() === 'cookieless') {
        // Warn rather than debug, once per init(): isTrackingEnabled() returns true in cookieless,
        // so `if (isTrackingEnabled()) await identify(id)` — the pre-flight check the README used to
        // recommend — takes the branch, resolves cleanly, and identifies nobody. A debug-gated
        // message is invisible to exactly the integrator who needs it. Once per init() because a
        // cookieless site may call identify() on every page.
        if (!cookielessIdentifyWarned) {
          cookielessIdentifyWarned = true
          log.warn(
            'identify() is disabled in cookieless mode and this call was dropped — grant consent to enable identity. Gate on getTrackingConsent() === "granted" rather than isTrackingEnabled(), which is true in cookieless mode.',
          )
        }
      } else {
        log.debug('identify() dropped because tracking consent is denied.')
      }
      return
    }
    if (state.dryRun) {
      log.debug('dryRun: would identify')
      return
    }

    const firstIdentify = !isIdentified()
    let deviceId = ''
    if (firstIdentify) {
      try {
        deviceId = localStorage.getItem(DEVICE_ID_KEY) ?? ''
      } catch (err) {
        log.warn('localStorage access failed for device ID, skipping push device linking:', err)
      }
    }

    const req = create(IdentifyRequestSchema, {
      externalId,
      traits,
      ...(firstIdentify && { anonymousId: getAnonymousId() }),
      ...(deviceId && { deviceId }),
    })

    try {
      await unaryCall(state.config.endpoint, state.apiKey, ProfilesSDKService.method.identify, req, ONE_SHOT_TIMEOUT_MS)
      markIdentified(externalId)
    } catch (err) {
      // The server is the sole validator (the SDK does no client-side field checks by design), so a
      // rejection here is the only signal that a trait or externalId was invalid. Surface the error
      // as-is: an RpcError carries the server's message plus a gRPC code with whatever field-level
      // detail the server chose to include.
      log.error('Failed to identify:', err)
    }
  } catch (err) {
    // Don't interpolate externalId: it is frequently PII (email, account id).
    log.error('Unexpected error in identify():', err)
  }
}

/** This function must never throw. Callers (e.g. monkey-patched history.pushState) rely on it being safe. */
export const track: TrackFn = (kind: string, props?: Record<string, unknown>, opts?: TrackOptions) => {
  try {
    if (typeof window === 'undefined') {
      return
    }

    if (!state) {
      log.warn('track() called before init().')
      return
    }

    const consent = state.trackingConsent.getConsent()

    // Allow-list, not a deny-check. Written as `if (consent === 'denied') return` plus a binary
    // ternary, every state that was not explicitly handled fell through to the full-identity arm —
    // so a fourth state added later meaning "more restrictive than granted" would silently get full
    // tracking *and* a persisted session, deviceId and anonymous ID, with neither the compiler nor
    // the suite objecting. Here an unhandled state resolves to null and the event drops, and
    // `unreachable` makes widening TrackingConsent a compile error at this dispatch — the one place
    // that has to make the decision.
    //
    // Cookieless: the server derives identity. That arm never touches the identity modules, so their
    // lazy-create/refresh paths cannot write anything — scoped to track() deliberately, since init()
    // and setTrackingConsent() do reach them (to restore into memory and to purge).
    let identity: EventIdentity | null = null
    if (consent === 'granted') {
      identity = { sessionId: resolveSessionId(), distinctId: resolveDistinctId() }
    } else if (consent === 'cookieless') {
      identity = { cookieless: true }
    } else if (consent === 'denied') {
      log.debug(`track("${kind}") dropped because tracking consent is denied.`)
    } else {
      unreachable(consent)
      log.error(`track("${kind}") dropped: unhandled tracking consent state ${JSON.stringify(consent)}.`)
    }
    if (!identity) {
      return
    }

    log.debug(`track("${kind}")`)
    const immediate = opts?.immediate ?? false
    const event = toEvent(state.config.projectId, kind, identity, props, opts)
    if (!event) {
      // toEvent logged the reason (error, or debug for a beforeSend drop)
      return
    }
    if (state.dryRun) {
      log.debug(`dryRun: would send "${kind}"`)
      return
    }
    state.transport.send(event, { immediate }).catch((err: Error) => log.error(`Failed to send event "${kind}":`, err))
  } catch (err) {
    log.error(`Unexpected error in track("${kind}"):`, err)
  }
}
