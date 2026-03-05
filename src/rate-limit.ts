import type { EventData, SendOptions, Transport } from './transport.js'

export function createRateLimitedTransport(inner: Transport, maxPerSecond: number): Transport {
  if (typeof window === 'undefined') return inner

  let tokens = maxPerSecond
  let lastRefill = Date.now()
  const pending: { event: EventData; options?: SendOptions }[] = []
  const maxPending = maxPerSecond * 10
  let drainTimer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false

  function refill() {
    const now = Date.now()
    tokens = Math.min(maxPerSecond, tokens + ((now - lastRefill) / 1000) * maxPerSecond)
    lastRefill = now
  }

  function drain() {
    if (destroyed) return
    refill()
    while (pending.length > 0 && tokens >= 1) {
      tokens -= 1
      const item = pending.shift()!
      inner.send(item.event, item.options).catch(() => {})
    }
    if (pending.length > 0) {
      scheduleDrain()
    }
  }

  function scheduleDrain() {
    if (drainTimer !== null || destroyed) return
    drainTimer = setTimeout(() => {
      drainTimer = null
      drain()
    }, 1000 / maxPerSecond)
  }

  return {
    async send(event: EventData, options?: SendOptions) {
      if (destroyed) return
      refill()
      if (tokens >= 1) {
        tokens -= 1
        return inner.send(event, options)
      }
      if (pending.length >= maxPending) {
        console.warn(`[Cotton SDK] Rate limit buffer full (${maxPending}), dropping oldest event`)
        pending.shift()
      }
      pending.push({ event, options })
      scheduleDrain()
    },
    destroy(): void {
      destroyed = true
      if (drainTimer !== null) {
        clearTimeout(drainTimer)
        drainTimer = null
      }
      for (const item of pending) {
        inner.send(item.event, item.options).catch(() => {})
      }
      pending.length = 0
      inner.destroy?.()
    },
  }
}
