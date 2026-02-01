export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type TrackFn<T extends string = string> = (eventName: T, properties?: Record<string, JsonValue>) => void

export interface EventData {
  readonly eventName: string
  readonly properties: Readonly<Record<string, JsonValue>>
  readonly timestamp: number
}

export interface Transport {
  send(event: EventData): Promise<void>
  destroy?(): void
}

// Mock transport for development - replace with ConnectRPC client
export function createTransport(endpoint: string): Transport {
  console.log(`Initialized mock transport to ${endpoint}`)
  return {
    async send(event: EventData) {
      console.log(`[CottonTransport] Sending event:`, event)
    },
  }
}
