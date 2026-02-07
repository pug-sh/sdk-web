import type { EventData, SendOptions, Transport } from './transport.js'

export interface QueueStorage {
  push(event: EventData): void
  lock(limit: number): readonly EventData[]
  commit(): void
  rollback(): void
  readonly size: number
}

function isLocalStorageAvailable(): boolean {
  try {
    const testKey = '__cotton_ls_test__'
    localStorage.setItem(testKey, '1')
    localStorage.removeItem(testKey)
    return true
  } catch {
    return false
  }
}

export function createMemoryQueueStorage(maxQueueSize: number): QueueStorage {
  let buffer: EventData[] = []
  let locked = 0

  return {
    push(event: EventData) {
      if (buffer.length >= maxQueueSize) {
        if (locked < buffer.length) {
          buffer.splice(locked, 1)
        } else {
          buffer.shift()
          locked--
        }
        console.warn('[Cotton SDK] Queue full, dropping oldest event')
      }
      buffer.push(event)
    },
    lock(limit: number): readonly EventData[] {
      if (locked > 0) return []
      locked = Math.min(limit, buffer.length)
      return buffer.slice(0, locked)
    },
    commit(): void {
      buffer.splice(0, locked)
      locked = 0
    },
    rollback(): void {
      locked = 0
    },
    get size(): number {
      return buffer.length - locked
    },
  }
}

export function createLocalStorageQueueStorage(key: string, maxQueueSize: number): QueueStorage {
  let buffer: EventData[]
  try {
    const raw = localStorage.getItem(key)
    buffer = raw ? (JSON.parse(raw) as EventData[]) : []
  } catch (err) {
    console.error('[Cotton SDK] Failed to hydrate queue from localStorage:', err)
    buffer = []
  }

  function persist(): void {
    try {
      if (buffer.length === 0) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, JSON.stringify(buffer))
      }
    } catch {
      console.warn('[Cotton SDK] localStorage write failed, events may be lost')
    }
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  function debouncedPersist(): void {
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persist()
    }, 1000)
  }

  let locked = 0

  return {
    push(event: EventData) {
      if (buffer.length >= maxQueueSize) {
        if (locked < buffer.length) {
          buffer.splice(locked, 1)
        } else {
          buffer.shift()
          locked--
        }
        console.warn('[Cotton SDK] Queue full, dropping oldest event')
      }
      buffer.push(event)
      debouncedPersist()
    },
    lock(limit: number): readonly EventData[] {
      if (locked > 0) return []
      locked = Math.min(limit, buffer.length)
      return buffer.slice(0, locked)
    },
    commit(): void {
      buffer.splice(0, locked)
      locked = 0
      persist()
    },
    rollback(): void {
      locked = 0
    },
    get size(): number {
      return buffer.length - locked
    },
  }
}

export function createDefaultQueueStorage(key: string, maxQueueSize: number): QueueStorage {
  if (isLocalStorageAvailable()) {
    return createLocalStorageQueueStorage(key, maxQueueSize)
  }
  console.warn('[Cotton SDK] localStorage not available, using in-memory queue (events will not persist across page loads)')
  return createMemoryQueueStorage(maxQueueSize)
}

export interface BatchConfig {
  readonly maxSize: number
  readonly maxWaitMs: number
  readonly maxQueueSize: number
  readonly storageKey?: string
  readonly storage?: QueueStorage
}

export const DEFAULT_BATCH_CONFIG: Omit<BatchConfig, 'storage' | 'storageKey'> = {
  maxSize: 10,
  maxWaitMs: 5000,
  maxQueueSize: 1000,
}

const PERMANENT_GRPC_CODES = new Set([3, 5, 7, 16])

function isPermanentError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  if ('code' in err && typeof (err as Record<string, unknown>).code === 'number') {
    return PERMANENT_GRPC_CODES.has((err as { code: number }).code)
  }
  if ('status' in err && typeof (err as Record<string, unknown>).status === 'number') {
    const status = (err as { status: number }).status
    return status >= 400 && status < 500
  }
  return false
}

export function createBatchedTransport(inner: Transport, config: BatchConfig): Transport {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return inner
  }

  const storage = config.storage ?? createDefaultQueueStorage(config.storageKey ?? '__cotton_queue__', config.maxQueueSize)
  let timer: ReturnType<typeof setTimeout> | null = null
  let flushing = false
  let destroyed = false

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleFlush(): void {
    if (timer !== null || destroyed) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, config.maxWaitMs)
  }

  function sendEvents(batch: readonly EventData[]): Promise<void | void[]> {
    return inner.sendBatch
      ? inner.sendBatch(batch)
      : Promise.all(batch.map((event) => inner.send(event)))
  }

  // TODO: Use navigator.sendBeacon once ConnectRPC transport is wired in
  function flush(): void {
    if (destroyed || flushing) return
    clearTimer()
    const batch = storage.lock(config.maxSize)
    if (batch.length === 0) return

    flushing = true

    sendEvents(batch)
      .then(() => {
        storage.commit()
      })
      .catch((err) => {
        if (isPermanentError(err)) {
          storage.commit()
        } else {
          storage.rollback()
        }
        console.error('[Cotton SDK] Failed to send batch:', err)
      })
      .finally(() => {
        flushing = false
        if (destroyed) return
        if (storage.size > 0) {
          scheduleFlush()
        }
      })
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      flush()
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', flush)

  return {
    async send(event: EventData, options?: SendOptions): Promise<void> {
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
      if (storage.size >= config.maxSize) {
        flush()
      } else {
        scheduleFlush()
      }
    },

    // TODO: Use navigator.sendBeacon once ConnectRPC transport is wired in
    destroy(): void {
      destroyed = true
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', flush)

      const remaining = storage.lock(storage.size)
      if (remaining.length > 0) {
        storage.commit()
        sendEvents(remaining)
          .catch((err) => console.error('[Cotton SDK] Failed to send remaining batch on destroy:', err))
          .finally(() => { inner.destroy?.() })
        return
      }
      inner.destroy?.()
    },
  }
}
