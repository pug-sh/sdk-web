export interface EventData {
  eventName: string;
  properties: Record<string, any>;
  timestamp: number;
}

export interface Transport {
  send(event: EventData): Promise<void>;
}

// Placeholder for the generated gRPC client
export class GrpcTransport implements Transport {
  // In a real implementation, this would hold the gRPC client instance
  // private client: Any;

  constructor(endpoint: string) {
    console.log(`Initialized gRPC transport to ${endpoint}`);
  }

  async send(event: EventData): Promise<void> {
    // Placeholder logic to "push" to server
    // In reality, this would call the generated gRPC method
    console.log(`[CottonTransport] Sending event:`, event);
    return Promise.resolve();
  }
}
