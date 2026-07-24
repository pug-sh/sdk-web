import { fromJson, JsonValue, toJson } from '@bufbuild/protobuf'
import { type Event, EventSchema } from './gen/sdk/events/v1/events_pb.js'
import { log } from './logger.js'
import { GrpcCode, RpcError } from './rpc.js'
import { createTransport } from './transport.js'
import { isStorageAvailable, makeStorageKey } from './utils.js'

interface SendOptions {
  readonly immediate?: boolean
}

// Queue storage uses a two-phase lock/commit/rollback protocol:
// lock(n) reserves up to n events and returns them; while locked, size and
// peekUnlocked() exclude locked events and subsequent lock() calls return [].
// commit() permanently removes locked events. rollback() releases the lock
// without removing events. Only one lock can be active at a time.
const createMemoryQueueStorage = (maxQueueSize: number) => {
  const buffer: Event[] = []
  let locked = 0

  return {
    push: (event: Event) => {
      if (buffer.length >= maxQueueSize) {
        if (locked >= buffer.length) {
          log.warn('Queue full and flush in progress, dropping new event')
          return
        }
        log.warn('Queue full, dropping oldest unlocked event')
        buffer.splice(locked, 1)
      }
      buffer.push(event)
    },
    lock: (limit: number) => {
      if (locked > 0) {
        return []
      }
      locked = Math.min(limit, buffer.length)
      return buffer.slice(0, locked)
    },
    commit: () => {
      buffer.splice(0, locked)
      locked = 0
    },
    peekUnlocked: () => buffer.slice(locked),
    rollback: () => (locked = 0),
    dispose: () => {},
    // Consent teardown. Nothing to confirm — this queue never reaches the device — but it shares the
    // shape so callers can purge both without asking which is which.
    purge: () => {
      buffer.length = 0
      locked = 0
      return true
    },
    get size() {
      return buffer.length - locked
    },
  }
}

const createLocalStorageQueueStorage = (key: string, maxQueueSize: number) => {
  let buffer: Event[]
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) {
      // Deserialize per-item so valid events survive when individual entries
      // are corrupt (e.g. after an SDK upgrade changes the proto schema).
      let dropped = 0
      buffer = parsed.reduce<Event[]>((acc, item: unknown, i: number) => {
        try {
          acc.push(fromJson(EventSchema, item as JsonValue))
        } catch (e) {
          dropped++
          log.warn(`Skipping corrupt event at index ${i} during hydration:`, e)
        }
        return acc
      }, [])
      if (dropped > 0) {
        log.warn(`Dropped ${dropped} corrupt event(s) during hydration, ${buffer.length} recovered.`)
      }
    } else {
      if (parsed !== null) {
        log.warn('Corrupt queue in localStorage (not an array), discarding.')
        localStorage.removeItem(key)
      }
      buffer = []
    }
  } catch (err) {
    // JSON.parse or localStorage.getItem failed — the entire payload is unreadable.
    log.error('Failed to hydrate queue from localStorage, discarding:', err)
    try {
      localStorage.removeItem(key)
    } catch (removeErr) {
      log.warn('Also failed to remove corrupt queue from localStorage:', removeErr)
    }
    buffer = []
  }

  const persist = () => {
    try {
      if (buffer.length === 0) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, JSON.stringify(buffer.map(e => toJson(EventSchema, e))))
      }
    } catch (err) {
      log.warn('localStorage write failed, events may be lost:', err)
    }
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const debouncedPersist = () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
    }
    persistTimer = setTimeout(() => {
      persistTimer = null
      persist()
    }, 1000)
  }

  let locked = 0

  return {
    push: (event: Event) => {
      if (buffer.length >= maxQueueSize) {
        if (locked >= buffer.length) {
          log.warn('Queue full and flush in progress, dropping new event')
          return
        }
        log.warn('Queue full, dropping oldest unlocked event')
        buffer.splice(locked, 1)
      }
      buffer.push(event)
      debouncedPersist()
    },
    lock: (limit: number) => {
      if (locked > 0) {
        return []
      }
      locked = Math.min(limit, buffer.length)
      return buffer.slice(0, locked)
    },
    commit: () => {
      buffer.splice(0, locked)
      locked = 0
      persist()
    },
    peekUnlocked: () => buffer.slice(locked),
    rollback: () => (locked = 0),
    dispose: () => {
      if (persistTimer !== null) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      persist()
    },
    /**
     * Consent teardown: drop every queued event and remove the key from the device.
     *
     * Cancels the pending debounce first — otherwise a persist scheduled before the withdrawal
     * fires afterwards and rewrites the very payloads this just removed. Returns false when the key
     * is still readable, so a withdrawal that did not fully land is detectable rather than assumed.
     */
    purge: () => {
      if (persistTimer !== null) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      buffer = []
      locked = 0
      try {
        localStorage.removeItem(key)
        return localStorage.getItem(key) === null
      } catch (err) {
        log.warn('Failed to remove the persisted event queue:', err)
        return false
      }
    },
    get size() {
      return buffer.length - locked
    },
  }
}

const createDefaultQueueStorage = (key: string, maxQueueSize: number) => {
  if (isStorageAvailable()) {
    return createLocalStorageQueueStorage(key, maxQueueSize)
  }
  log.warn('localStorage not available, using in-memory queue (events will not persist across page loads)')
  return createMemoryQueueStorage(maxQueueSize)
}

export interface BatchConfig {
  readonly maxSize: number
  readonly maxWaitMs: number
  readonly maxQueueSize: number
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  maxSize: 10,
  maxWaitMs: 5000,
  maxQueueSize: 1000,
}

// gRPC codes for client errors / server rejections that retrying cannot fix. Uses the shared
// GrpcCode vocabulary from rpc.ts (the producer) so this consumer table can't silently drift
// from the codes rpc.ts actually emits.
const PERMANENT_GRPC_CODES = new Set<GrpcCode>([
  GrpcCode.InvalidArgument,
  GrpcCode.NotFound,
  GrpcCode.AlreadyExists,
  GrpcCode.PermissionDenied,
  GrpcCode.FailedPrecondition,
  GrpcCode.Unimplemented,
  GrpcCode.Unauthenticated,
])

// The server accepts events per-event and reports the count (BatchCreateResponse.accepted). A
// shortfall means it silently rejected some — surface it, since committing the batch erases those
// events without a trace. The SDK leaves validation to the server (no client-side field checks),
// so this warn is the only signal an operator gets that otherwise-valid track() calls are dropping.
const warnIfPartiallyAccepted = (accepted: number, sent: number) => {
  if (accepted < sent) {
    log.warn(
      `Server accepted ${accepted}/${sent} events; ${sent - accepted} were rejected and dropped. ` +
        "Check event validity (kind must match ^[a-zA-Z0-9_.-]+$; custom-property keys must not start with '$').",
    )
  }
}

const isPermanentError = (err: unknown) => {
  if (err instanceof RpcError) {
    return PERMANENT_GRPC_CODES.has(err.code)
  }
  // Non-RpcError errors (TypeError, SyntaxError, etc.) indicate code or
  // data bugs that retrying cannot fix. Treat them as permanent to avoid
  // poison events stalling the entire queue in an infinite retry loop.
  return true
}

type TransportState = 'idle' | 'flushing' | 'destroyed'

export const createBatchedTransport = (
  endpoint: string,
  apiKey: string,
  projectId: string,
  partialConfig?: Partial<BatchConfig>,
) => {
  const merged = { ...DEFAULT_BATCH_CONFIG, ...partialConfig }
  const validated = (name: string, value: number, min: number, fallback: number) => {
    if (value >= min) {
      return value
    }
    log.warn(`batch.${name} must be >= ${min}, using default.`)
    return fallback
  }

  const maxSize = validated('maxSize', merged.maxSize, 1, DEFAULT_BATCH_CONFIG.maxSize)
  const maxWaitMs = validated('maxWaitMs', merged.maxWaitMs, 0, DEFAULT_BATCH_CONFIG.maxWaitMs)
  const maxQueueSize = validated('maxQueueSize', merged.maxQueueSize, 1, DEFAULT_BATCH_CONFIG.maxQueueSize)
  const storageKey = makeStorageKey(projectId, 'queue')

  const inner = createTransport(endpoint, apiKey)
  const storage = createDefaultQueueStorage(storageKey, maxQueueSize)
  // Cookieless events must never touch the device: they bypass the
  // localStorage-backed queue for a memory-only twin. Cost, accepted: a
  // hard-killed tab loses whatever this queue is holding (the beacon covers
  // ordinary navigation) — the alternative is persisting event payloads,
  // which is the thing cookieless mode promises not to do.
  //
  // That loss is bounded by maxQueueSize, NOT by maxWaitMs. maxWaitMs bounds
  // only the happy path: a transient send failure rolls the batch back here
  // and retries indefinitely, so events can sit for far longer — measured at
  // 60s with maxWaitMs=50 (1200x) across 1201 attempts, still deliverable
  // when sends recovered.
  const cookielessStorage = createMemoryQueueStorage(maxQueueSize)
  const storageFor = (event: Event) => (event.cookieless ? cookielessStorage : storage)
  const totalSize = () => storage.size + cookielessStorage.size
  let timer: ReturnType<typeof setTimeout> | null = null
  let state: TransportState = 'idle'
  // Round-robin cursor, consulted only when maxSize leaves one indivisible slot. See flush().
  let preferCookieless = false

  /**
   * Reports a failed `sendBeacon` at the level each queue's outcome actually warrants.
   *
   * `beacon()` returns false whenever `sendBeacon` is absent or blocked — routine with
   * analytics-blocking extensions, not exotic. The consented queue is localStorage-backed and
   * recovers on the next `init()`; the cookieless queue is memory-only and dies with the page, so
   * its loss is permanent. Reporting both as "they remain queued" told the reader the opposite of
   * what happened to half of them.
   */
  const reportBeaconLoss = (consentedCount: number, cookielessCount: number, phase: string): void => {
    if (consentedCount > 0) {
      // Only recoverable if there is somewhere to recover from: createDefaultQueueStorage falls back
      // to an in-memory queue when localStorage is unavailable, where this loss is permanent too.
      if (isStorageAvailable()) {
        log.warn(
          `sendBeacon failed ${phase}; ${consentedCount} events remain in the persisted queue and will retry on next init().`,
        )
      } else {
        log.error(
          `sendBeacon failed ${phase}; ${consentedCount} events were dropped — localStorage is unavailable, so the queue cannot be recovered.`,
        )
      }
    }
    if (cookielessCount > 0) {
      log.error(
        `sendBeacon failed ${phase}; ${cookielessCount} cookieless events were dropped — the cookieless queue is memory-only and cannot be recovered.`,
      )
    }
  }

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const scheduleFlush = () => {
    if (timer !== null || state === 'destroyed') {
      return
    }
    timer = setTimeout(() => {
      timer = null
      flush()
    }, maxWaitMs)
  }

  const flush = () => {
    if (state !== 'idle') {
      return
    }
    clearTimer()
    // One in-flight batch at a time (the state machine serializes), drawn from BOTH queues in a
    // single request — the way beaconFlush/destroy already build theirs, and what BatchCreate
    // accepts. Targeting one queue per flush starved the cookieless queue for the entire duration
    // of any continuous consented stream (`storage.size > 0` always chose `storage`) while
    // `totalSize() >= maxSize` tripped the threshold on every arriving event, degrading the
    // consented queue from batched sends to one request per event. Worse, `storage` is
    // localStorage-backed, so a single transiently-failing consented event survives page loads and
    // could block cookieless collection on that device indefinitely.
    // Reserve part of the budget for the cookieless queue whenever it has anything waiting. Draining
    // the consented queue first with the WHOLE budget left `lock(maxSize - consented.length)` equal
    // to lock(0) on every flush once the consented backlog reached maxSize — so a backlog that kept
    // failing transiently (offline user, endpoint down) starved cookieless collection outright:
    // measured at 204 send attempts, none carrying a cookieless event. Routing the two queues
    // separately narrowed the original bug; this closes it.
    // Reserve part of the budget for the cookieless queue whenever it has anything waiting.
    //
    // The reserve is floored at 1 rather than derived as a remainder, and when the two floors cannot
    // both fit — maxSize 1, where there is exactly one slot — the queues ALTERNATE instead of one
    // owning it. The previous form floored only the *consented* budget at 1, which at maxSize 1 is
    // the whole budget, so `cookielessStorage.lock(maxSize - consented.length)` was lock(0) on every
    // flush forever. maxSize 1 is legal (validated with a minimum of 1) and is the natural setting
    // for per-event delivery, so that was a live starvation, not a theoretical one. Any fixed split
    // degenerates when the budget cannot be split; only alternation is correct at every maxSize.
    const cookielessPending = cookielessStorage.size
    let consentedBudget = maxSize
    if (cookielessPending > 0) {
      const cookielessReserve = Math.min(cookielessPending, Math.max(1, Math.floor(maxSize / 2)))
      consentedBudget = maxSize - cookielessReserve
      if (consentedBudget < 1) {
        // No room for both. Take turns, so neither queue can be starved by a sustained stream in
        // the other. The flag advances only here, so it cannot drift on flushes that never contend.
        consentedBudget = preferCookieless ? 0 : 1
        preferCookieless = !preferCookieless
      }
    }
    const consented = storage.lock(consentedBudget)
    const cookieless = cookielessStorage.lock(maxSize - consented.length)
    const batch = [...consented, ...cookieless]
    if (batch.length === 0) {
      return
    }

    state = 'flushing'

    // Only a queue that contributed holds a lock; committing or rolling back the other would act on
    // a lock it does not own. Mirrors the guarded form in destroy().
    const settle = (outcome: 'commit' | 'rollback') => {
      if (consented.length > 0) {
        outcome === 'commit' ? storage.commit() : storage.rollback()
      }
      if (cookieless.length > 0) {
        outcome === 'commit' ? cookielessStorage.commit() : cookielessStorage.rollback()
      }
    }

    inner
      .sendBatch(batch)
      .then(res => {
        warnIfPartiallyAccepted(res.accepted, batch.length)
        settle('commit')
      })
      .catch(err => {
        if (isPermanentError(err)) {
          settle('commit')
          log.error(`Permanent error, ${batch.length} events dropped (will NOT retry):`, err)
        } else {
          settle('rollback')
          // "will retry" is only true if the events are still queued. A purgeQueue() that landed
          // while this batch was in flight empties the buffer under it, so the rollback restores
          // nothing and the retry never happens — reporting one would misdescribe the outcome.
          if (totalSize() > 0) {
            log.warn('Transient error sending batch, will retry:', err)
          } else {
            log.warn(
              `Transient error sending batch; the queue was cleared while it was in flight, so ${batch.length} events were dropped:`,
              err,
            )
          }
        }
      })
      .finally(() => {
        if (state === 'destroyed') {
          return
        }
        state = 'idle'
        if (totalSize() > 0) {
          scheduleFlush()
        }
      })
  }

  const beaconFlush = () => {
    if (state === 'destroyed') {
      return
    }
    clearTimer()
    if (state === 'flushing') {
      // In-flight flush owns the locked events. Best-effort beacon the
      // unlocked tail from both queues — they stay queued regardless, so
      // duplicates are possible if the page survives but events aren't lost.
      const consentedTail = storage.peekUnlocked()
      const cookielessTail = cookielessStorage.peekUnlocked()
      const unlocked = [...consentedTail, ...cookielessTail]
      // The return value was discarded here, so a blocked sendBeacon lost the cookieless tail with
      // no diagnostic at all — the one branch that said nothing about the one loss that is permanent.
      if (unlocked.length > 0 && !inner.beacon?.(unlocked)) {
        reportBeaconLoss(consentedTail.length, cookielessTail.length, 'on page hide')
      }
      return
    }
    // Drain both queues in one payload — there may not be another chance to
    // send on page hide, and BatchCreate accepts mixed events.
    const a = storage.lock(storage.size)
    const b = cookielessStorage.lock(cookielessStorage.size)
    const batch = [...a, ...b]
    if (batch.length === 0) {
      return
    }
    // Guarded on contribution like flush()/destroy(), rather than relying on the unstated invariant
    // that no lock is held at `idle`. That invariant does hold here (the early return above), but
    // destroy()'s comment explains why acting on a lock you do not own is a real hazard — leaving
    // one call site unguarded invites a reader to conclude it is safe everywhere.
    if (inner.beacon?.(batch)) {
      if (a.length > 0) {
        storage.commit()
      }
      if (b.length > 0) {
        cookielessStorage.commit()
      }
    } else {
      if (a.length > 0) {
        storage.rollback()
      }
      if (b.length > 0) {
        cookielessStorage.rollback()
      }
      reportBeaconLoss(a.length, b.length, 'on page hide')
    }
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      beaconFlush()
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', beaconFlush)

  return {
    send: async (event: Event, options?: SendOptions) => {
      if (state === 'destroyed') {
        return
      }
      if (options?.immediate) {
        try {
          const res = await inner.send(event)
          warnIfPartiallyAccepted(res.accepted, 1)
        } catch (err) {
          if (isPermanentError(err)) {
            log.error('Permanent error sending event, dropping:', err)
            return
          }
          storageFor(event).push(event)
          scheduleFlush()
        }
        return
      }
      storageFor(event).push(event)
      if (totalSize() >= maxSize) {
        flush()
      } else {
        scheduleFlush()
      }
    },

    /**
     * Consent withdrawal: make one best-effort send of what was already collected, then drop both
     * queues from the device. Returns false when the persisted key survived the removal.
     *
     * Queued events carry `sessionId` and `distinctId` as top-level fields, and after `identify()`
     * the `distinctId` IS the `externalId` — so the queue is identity storage in every sense the
     * profile and session keys are, and it was the one such store the consent teardown never
     * reached. Leaving it meant a withdrawal that returned `true` while identified payloads stayed
     * on disk, to be beaconed on the next navigation and again on the following visit.
     *
     * The send is `beacon`, not `flush`: withdrawal is a synchronous user action that must not wait
     * on the network, and the events must be gone from the device when this returns either way.
     * Withdrawal is forward-looking — data collected under valid consent stays lawful to process —
     * so dropping these unsent would lose events the user had agreed to at collection time.
     *
     * `peekUnlocked()` excludes any in-flight batch, which its own flush is already delivering; that
     * flush's later commit/rollback lands on an emptied buffer and is a harmless no-op.
     */
    purgeQueue: (): boolean => {
      let delivered = true
      if (state !== 'destroyed') {
        const consentedTail = storage.peekUnlocked()
        const cookielessTail = cookielessStorage.peekUnlocked()
        const pending = [...consentedTail, ...cookielessTail]
        // The third beacon call site, and the only one that discarded this result — so a blocked
        // sendBeacon destroyed everything collected under valid consent, returned true, and said
        // nothing. Both other sites (beaconFlush, destroy) already report through reportBeaconLoss.
        // The counts are captured before the call because purge() empties the buffers below.
        if (pending.length > 0 && !inner.beacon?.(pending)) {
          reportBeaconLoss(consentedTail.length, cookielessTail.length, 'during consent withdrawal')
          delivered = false
        }
      }
      const consentedPurged = storage.purge()
      const cookielessPurged = cookielessStorage.purge()
      return consentedPurged && cookielessPurged && delivered
    },
    destroy: () => {
      state = 'destroyed'
      clearTimer()
      storage.dispose()
      cookielessStorage.dispose()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', beaconFlush)

      // If a flush is in-flight it owns that queue's lock, so lock() here returns []. What gets
      // beaconed for that queue is the queue's *unlocked tail* — peekUnlocked() excludes the
      // in-flight batch, which the flush's own commit/rollback still owns and which is NEVER
      // committed here (committing under a held lock would splice that batch out from under it).
      // A queue we lock ourselves is committed on beacon success as before.
      //
      // Duplicate risk, same as beaconFlush's in-flight branch and called out for the same reason: a
      // peeked tail is sent but stays queued, so if the in-flight flush then succeeds and the page
      // survives, those events are delivered twice. Accepted — losing them is worse, and BatchCreate
      // is keyed by eventId.
      const a = storage.lock(storage.size)
      const b = cookielessStorage.lock(cookielessStorage.size)
      const consentedTail = a.length === 0 ? storage.peekUnlocked() : []
      const cookielessTail = b.length === 0 ? cookielessStorage.peekUnlocked() : []
      const payload = [...a, ...b, ...consentedTail, ...cookielessTail]
      if (payload.length > 0) {
        if (inner.beacon?.(payload)) {
          if (a.length > 0) {
            storage.commit()
          }
          if (b.length > 0) {
            cookielessStorage.commit()
          }
        } else {
          if (a.length > 0) {
            storage.rollback()
          }
          if (b.length > 0) {
            cookielessStorage.rollback()
          }
          reportBeaconLoss(a.length + consentedTail.length, b.length + cookielessTail.length, 'during destroy()')
        }
      }
    },
  }
}
