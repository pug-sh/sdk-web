import { EventSchema, type Event } from '@buf/fivebits_cotton.bufbuild_es/events/v1/events_pb.js'
import { fromJson, JsonValue, toJson } from '@bufbuild/protobuf'
import { ConnectError } from '@connectrpc/connect'
import { createTransport } from './transport.js'

interface SendOptions {
  readonly immediate?: boolean
}

const isLocalStorageAvailable = () => {
  try {
    const testKey = '__cotton_ls_test__'
    localStorage.setItem(testKey, '1')
    localStorage.removeItem(testKey)
    return true
  } catch {
    return false
  }
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
          console.warn('[Cotton SDK] Queue full and flush in progress, dropping new event')
          return
        }
        console.warn('[Cotton SDK] Queue full, dropping oldest unlocked event')
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
          console.warn(`[Cotton SDK] Skipping corrupt event at index ${i} during hydration:`, e)
        }
        return acc
      }, [])
      if (dropped > 0) {
        console.warn(`[Cotton SDK] Dropped ${dropped} corrupt event(s) during hydration, ${buffer.length} recovered.`)
      }
    } else {
      if (parsed !== null) {
        console.warn('[Cotton SDK] Corrupt queue in localStorage (not an array), discarding.')
        localStorage.removeItem(key)
      }
      buffer = []
    }
  } catch (err) {
    // JSON.parse or localStorage.getItem failed — the entire payload is unreadable.
    console.error('[Cotton SDK] Failed to hydrate queue from localStorage, discarding:', err)
    try {
      localStorage.removeItem(key)
    } catch (removeErr) {
      console.warn('[Cotton SDK] Also failed to remove corrupt queue from localStorage:', removeErr)
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
      console.warn('[Cotton SDK] localStorage write failed, events may be lost:', err)
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
          console.warn('[Cotton SDK] Queue full and flush in progress, dropping new event')
          return
        }
        console.warn('[Cotton SDK] Queue full, dropping oldest unlocked event')
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
    get size() {
      return buffer.length - locked
    },
  }
}

const createDefaultQueueStorage = (key: string, maxQueueSize: number) => {
  if (isLocalStorageAvailable()) {
    return createLocalStorageQueueStorage(key, maxQueueSize)
  }
  console.warn(
    '[Cotton SDK] localStorage not available, using in-memory queue (events will not persist across page loads)'
  )
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

// gRPC codes that indicate client errors or server rejections that retrying cannot fix.
// InvalidArgument(3), NotFound(5), AlreadyExists(6), PermissionDenied(7),
// FailedPrecondition(9), Unimplemented(12), Unauthenticated(16)
const PERMANENT_GRPC_CODES = new Set([3, 5, 6, 7, 9, 12, 16])

const isPermanentError = (err: unknown) => {
  if (err instanceof ConnectError) {
    return PERMANENT_GRPC_CODES.has(err.code)
  }
  // Non-ConnectError errors (TypeError, SyntaxError, etc.) indicate code or
  // data bugs that retrying cannot fix. Treat them as permanent to avoid
  // poison events stalling the entire queue in an infinite retry loop.
  return true
}

type TransportState = 'idle' | 'flushing' | 'destroyed'

export const createBatchedTransport = (
  endpoint: string,
  token: string,
  projectId: string,
  partialConfig?: Partial<BatchConfig>
) => {
  const merged = { ...DEFAULT_BATCH_CONFIG, ...partialConfig }
  const validated = (name: string, value: number, min: number, fallback: number) => {
    if (value >= min) return value
    console.warn(`[Cotton SDK] batch.${name} must be >= ${min}, using default.`)
    return fallback
  }

  const maxSize = validated('maxSize', merged.maxSize, 1, DEFAULT_BATCH_CONFIG.maxSize)
  const maxWaitMs = validated('maxWaitMs', merged.maxWaitMs, 0, DEFAULT_BATCH_CONFIG.maxWaitMs)
  const maxQueueSize = validated('maxQueueSize', merged.maxQueueSize, 1, DEFAULT_BATCH_CONFIG.maxQueueSize)
  const storageKey = `__cotton_queue_${projectId}__`

  const inner = createTransport(endpoint, token)
  const storage = createDefaultQueueStorage(storageKey, maxQueueSize)
  let timer: ReturnType<typeof setTimeout> | null = null
  let state: TransportState = 'idle'

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
    const batch = storage.lock(maxSize)
    if (batch.length === 0) {
      return
    }

    state = 'flushing'

    inner
      .sendBatch(batch)
      .then(storage.commit)
      .catch(err => {
        if (isPermanentError(err)) {
          storage.commit()
          console.error(`[Cotton SDK] Permanent error, ${batch.length} events dropped (will NOT retry):`, err)
        } else {
          storage.rollback()
          console.warn('[Cotton SDK] Transient error sending batch, will retry:', err)
        }
      })
      .finally(() => {
        if (state === 'destroyed') {
          return
        }
        state = 'idle'
        if (storage.size > 0) {
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
      // unlocked tail — they stay in the queue regardless, so duplicates
      // are possible if the page survives but events aren't lost.
      const unlocked = storage.peekUnlocked()
      if (unlocked.length > 0) {
        inner.beacon?.(unlocked)
      }
      return
    }
    // Drain the entire queue — there may not be another chance to send on page hide.
    const batch = storage.lock(storage.size)
    if (batch.length === 0) {
      return
    }
    if (inner.beacon?.(batch)) {
      storage.commit()
    } else {
      storage.rollback()
      console.warn(`[Cotton SDK] sendBeacon failed for ${batch.length} events; they remain queued for next flush.`)
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
          await inner.send(event)
        } catch (err) {
          if (isPermanentError(err)) {
            console.error('[Cotton SDK] Permanent error sending event, dropping:', err)
            return
          }
          storage.push(event)
          scheduleFlush()
        }
        return
      }
      storage.push(event)
      if (storage.size >= maxSize) {
        flush()
      } else {
        scheduleFlush()
      }
    },

    destroy: () => {
      state = 'destroyed'
      clearTimer()
      storage.dispose()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', beaconFlush)

      // If a flush is in-flight, its locked batch will complete normally via
      // the existing promise chain. Best-effort beacon the unlocked tail.
      if (storage.size > 0 && storage.lock(storage.size).length === 0) {
        const unlocked = storage.peekUnlocked()
        if (unlocked.length > 0) {
          inner.beacon?.(unlocked)
        }
        return
      }

      const remaining = storage.lock(storage.size)
      if (remaining.length > 0) {
        if (inner.beacon?.(remaining)) {
          storage.commit()
        } else {
          // Beacon failed — leave events in the queue for recovery on next init.
          storage.rollback()
        }
      }
    },
  }
}
