import type { EventData, SendOptions, Transport } from './transport.js'

export interface QueueStorage {
  push(event: EventData): void
  drain(): readonly EventData[]
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
  let warnedQueueFull = false
  return {
    push(event: EventData) {
      if (buffer.length >= maxQueueSize) {
        buffer.shift()
        if (!warnedQueueFull) {
          console.warn('[Cotton SDK] Queue full, dropping oldest events')
          warnedQueueFull = true
        }
      }
      buffer.push(event)
    },
    drain(): readonly EventData[] {
      const batch = buffer
      buffer = []
      return batch
    },
    get size(): number {
      return buffer.length
    },
  }
}

export function createLocalStorageQueueStorage(key: string, maxQueueSize: number): QueueStorage {
  const SYNC_INTERVAL = 2000
  let syncTimer: ReturnType<typeof setTimeout> | null = null

  // Hydrate from localStorage once; memory is the source of truth from here on
  let buffer: EventData[]
  try {
    const raw = localStorage.getItem(key)
    buffer = raw ? (JSON.parse(raw) as EventData[]) : []
  } catch {
    buffer = []
  }
  let dirty = false

  function persist(): void {
    if (!dirty) return
    try {
      if (buffer.length === 0) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, JSON.stringify(buffer))
      }
      dirty = false
    } catch {
      console.warn('[Cotton SDK] localStorage write failed, events may be lost')
    }
  }

  function schedulePersist(): void {
    if (syncTimer !== null) return
    syncTimer = setTimeout(() => {
      syncTimer = null
      persist()
    }, SYNC_INTERVAL)
  }

  function clearSyncTimer(): void {
    if (syncTimer !== null) {
      clearTimeout(syncTimer)
      syncTimer = null
    }
  }

  let warnedQueueFull = false

  return {
    push(event: EventData) {
      if (buffer.length >= maxQueueSize) {
        buffer.shift()
        if (!warnedQueueFull) {
          console.warn('[Cotton SDK] Queue full, dropping oldest events')
          warnedQueueFull = true
        }
      }
      buffer.push(event)
      dirty = true
      schedulePersist()
    },
    drain(): readonly EventData[] {
      clearSyncTimer()
      const batch = buffer
      buffer = []
      dirty = true
      persist()
      return batch
    },
    get size(): number {
      return buffer.length
    },
  }
}

export function createDefaultQueueStorage(key: string, maxQueueSize: number): QueueStorage {
  return isLocalStorageAvailable()
    ? createLocalStorageQueueStorage(key, maxQueueSize)
    : createMemoryQueueStorage(maxQueueSize)
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

export function createBatchedTransport(inner: Transport, config: BatchConfig): Transport {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return inner
  }

  const MAX_RETRIES = 5
  const BASE_BACKOFF_MS = 1000

  const storage = config.storage ?? createDefaultQueueStorage(config.storageKey ?? '__cotton_queue__', config.maxQueueSize)
  let timer: ReturnType<typeof setTimeout> | null = null
  let flushing = false
  let flushPending = false
  let destroyed = false
  let retryCount = 0

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleFlush(): void {
    if (timer !== null) return
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
    if (destroyed) return
    if (flushing) {
      flushPending = true
      return
    }
    clearTimer()
    const batch = storage.drain()
    if (batch.length === 0) return

    flushing = true

    sendEvents(batch)
      .then(() => {
        retryCount = 0
      })
      .catch((err) => {
        console.error('[Cotton SDK] Failed to send batch:', err)
        if (!destroyed) {
          retryCount++
          if (retryCount > MAX_RETRIES) {
            console.warn('[Cotton SDK] Max retries reached, dropping batch')
            retryCount = 0
            return
          }
          const newer = storage.drain()
          for (const event of batch) {
            storage.push(event)
          }
          for (const event of newer) {
            storage.push(event)
          }
        }
      })
      .finally(() => {
        flushing = false
        if (destroyed) return
        if (retryCount > 0 && storage.size > 0) {
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s
          const delay = BASE_BACKOFF_MS * Math.pow(2, retryCount - 1)
          clearTimer()
          timer = setTimeout(() => {
            timer = null
            flush()
          }, delay)
        } else if (flushPending || storage.size >= config.maxSize) {
          flushPending = false
          flush()
        } else if (storage.size > 0) {
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
        } catch {
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

    destroy(): void {
      destroyed = true
      clearTimer()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', flush)

      // TODO: Use navigator.sendBeacon once ConnectRPC transport is wired in
      const remaining = storage.drain()
      if (remaining.length > 0) {
        sendEvents(remaining).catch((err) =>
          console.error('[Cotton SDK] Failed to send remaining batch on destroy:', err),
        )
      }

      inner.destroy?.()
    },
  }
}
