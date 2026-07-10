import { type DescMessage, type DescMethodUnary, fromBinary, type MessageShape, toBinary } from '@bufbuild/protobuf'
import { log } from './logger.js'

const DEFAULT_TIMEOUT_MS = 5000

/**
 * Timeout for one-shot RPCs (`identify`, push `subscribe`) that — unlike batched events — are
 * NOT retried on failure. The 5s default is tuned for the batch path (a miss just retries next
 * flush); aborting a cold-started backend at 5s would permanently lose a one-shot, so give them
 * a more generous ceiling while staying bounded so an awaited call can't hang indefinitely.
 */
export const ONE_SHOT_TIMEOUT_MS = 15000

/**
 * The canonical gRPC status codes as a compile-time-enforced union. The producer (`rpc.ts`) and
 * the consumer (`batch.ts`'s permanent-vs-transient set) share this single source of truth, so
 * `new RpcError('x', 999)` is a type error and the two tables cannot silently drift apart. It
 * ships as a small frozen object: a `const enum` would be zero-runtime but can't be inlined
 * across files under the esbuild-based (per-file) test transform, so `batch.ts` would fail to
 * resolve its members. The object costs a few dozen bytes — negligible next to the removed deps.
 */
export const GrpcCode = {
  Canceled: 1,
  Unknown: 2,
  InvalidArgument: 3,
  DeadlineExceeded: 4,
  NotFound: 5,
  AlreadyExists: 6,
  PermissionDenied: 7,
  ResourceExhausted: 8,
  FailedPrecondition: 9,
  Aborted: 10,
  OutOfRange: 11,
  Unimplemented: 12,
  Internal: 13,
  Unavailable: 14,
  DataLoss: 15,
  Unauthenticated: 16,
} as const
export type GrpcCode = (typeof GrpcCode)[keyof typeof GrpcCode]

// Connect encodes errors as JSON with a *string* `code`; map it back to the numeric gRPC code
// so the batch layer can classify permanent vs. transient failures.
const CONNECT_CODE_TO_NUMBER: Record<string, GrpcCode> = {
  canceled: GrpcCode.Canceled,
  unknown: GrpcCode.Unknown,
  invalid_argument: GrpcCode.InvalidArgument,
  deadline_exceeded: GrpcCode.DeadlineExceeded,
  not_found: GrpcCode.NotFound,
  already_exists: GrpcCode.AlreadyExists,
  permission_denied: GrpcCode.PermissionDenied,
  resource_exhausted: GrpcCode.ResourceExhausted,
  failed_precondition: GrpcCode.FailedPrecondition,
  aborted: GrpcCode.Aborted,
  out_of_range: GrpcCode.OutOfRange,
  unimplemented: GrpcCode.Unimplemented,
  internal: GrpcCode.Internal,
  unavailable: GrpcCode.Unavailable,
  data_loss: GrpcCode.DataLoss,
  unauthenticated: GrpcCode.Unauthenticated,
}

/**
 * Error thrown by {@link unaryCall} for *server* rejections and network/timeout failures,
 * carrying a numeric gRPC status code the batch layer classifies as permanent or transient.
 * Network drops and timeouts surface as transient codes (`Unavailable` / `DeadlineExceeded`)
 * with the underlying error attached as `cause`; server rejections carry the code from the
 * Connect JSON error body. Replaces `@connectrpc/connect`'s `ConnectError`.
 *
 * Not every failure is an `RpcError`: a 2xx response whose body isn't valid protobuf (a
 * proxy/captive-portal/CDN page) and a `toBinary` serialization bug are *permanent* failures
 * surfaced as their raw error, so `batch.ts`'s `isPermanentError` (non-`RpcError` → permanent)
 * drops them instead of retrying the same bad request/response forever.
 */
export class RpcError extends Error {
  readonly code: GrpcCode
  // Declared explicitly: the ES2020 lib's `Error` has no `cause` (that arrived in ES2022).
  readonly cause?: unknown
  constructor(message: string, code: GrpcCode, cause?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

// Fallback classification when an error body isn't a Connect JSON error — a proxy/CDN/WAF page
// (HTML, or non-Connect JSON) such as a Cloudflare 403 bot-block or a 429. Classifies by HTTP
// status *class* instead of collapsing an unmapped status to unknown(2)/transient, which batch.ts
// would retry on every flush forever: 4xx client/proxy errors the identical request can't fix are
// permanent (batch.ts drops them); 429 and 5xx stay transient (retryable).
const codeFromHttpStatus = (status: number): GrpcCode => {
  switch (status) {
    case 401:
      return GrpcCode.Unauthenticated // permanent
    case 403:
      return GrpcCode.PermissionDenied // permanent — e.g. a Cloudflare WAF/bot block
    case 404:
      return GrpcCode.Unimplemented // permanent
    case 408: // request timeout — transient
    case 429: // rate limited — transient
      return GrpcCode.Unavailable
  }
  // 4xx (400, 405, 413, 415, 431, 451, …): a client/proxy rejection retrying can't fix —
  // permanent, so batch.ts drops it instead of re-sending the identical request every flush
  // until the queue fills and sheds its oldest events.
  if (status >= 400 && status < 500) {
    return GrpcCode.InvalidArgument
  }
  // 5xx and anything else: a server/gateway hiccup that may recover on retry — transient.
  return GrpcCode.Unavailable
}

const errorFromResponse = async (res: Response, methodName: string): Promise<RpcError> => {
  // Connect unary errors are JSON: { "code": "<string>", "message": "<text>" }.
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown }
    // A genuine Connect error carries a known string `code`; a non-Connect JSON body (proxy/CDN)
    // falls back to the HTTP status, same as a non-JSON body below.
    const code =
      typeof body.code === 'string'
        ? (CONNECT_CODE_TO_NUMBER[body.code] ?? codeFromHttpStatus(res.status))
        : codeFromHttpStatus(res.status)
    const message = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`
    return new RpcError(message, code)
  } catch (err) {
    // Non-JSON error body (a proxy/gateway/CDN page). Classify by HTTP status so an unretryable
    // 4xx block (e.g. a Cloudflare WAF/bot 403) is dropped, not retried forever. Log why the parse
    // failed at debug so a truncated real Connect error is distinguishable from a proxy HTML page.
    log.debug(`RPC ${methodName}: error body was not Connect JSON:`, err)
    return new RpcError(`HTTP ${res.status}`, codeFromHttpStatus(res.status))
  }
}

/**
 * Invokes a unary RPC over the Connect protocol with the binary (protobuf) codec — a
 * hand-rolled `fetch` replacing `@connectrpc/connect-web` to shrink the bundle. The
 * request message is serialized straight into the POST body and the response is parsed
 * from the binary body; the API key rides the `x-api-key` header. This is the same wire
 * format `transport.beacon` already uses.
 *
 * On failure it throws either an {@link RpcError} (server rejection, network drop, or timeout —
 * carrying a numeric gRPC code and, for network/timeout, a `cause`) or, for a permanent local
 * failure the batch layer must not retry (a 2xx body that isn't protobuf, or a `toBinary` bug),
 * the raw underlying error. Both are classified correctly by `batch.ts`'s `isPermanentError`.
 */
export const unaryCall = async <I extends DescMessage, O extends DescMessage>(
  endpoint: string,
  apiKey: string,
  method: DescMethodUnary<I, O>,
  message: MessageShape<I>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<MessageShape<O>> => {
  const url = `${endpoint.replace(/\/+$/, '')}/${method.parent.typeName}/${method.name}`
  // Serialize up front, outside the try: a toBinary failure is a permanent programming/data error,
  // so it must surface raw (permanent) rather than be caught below and mislabeled a network drop.
  const body = toBinary(method.input, message)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/proto',
        'connect-protocol-version': '1',
        'x-api-key': apiKey,
      },
      body,
      signal: controller.signal,
    })
    if (!res.ok) {
      throw await errorFromResponse(res, method.name)
    }
    // A 2xx whose body isn't protobuf (a misconfigured proxy / captive portal / CDN health page)
    // makes fromBinary throw. Check the content-type first so the failure carries a clear message
    // instead of a cryptic wire-format error; either way it's a non-RpcError → permanent (see catch).
    const contentType = res.headers.get('content-type') ?? ''
    if (contentType && !contentType.includes('proto')) {
      throw new Error(`RPC ${method.name}: expected a protobuf response but got content-type "${contentType}"`)
    }
    return fromBinary(method.output, new Uint8Array(await res.arrayBuffer()))
  } catch (err) {
    if (err instanceof RpcError) {
      throw err
    }
    // A timeout fires the AbortController; a network-level fetch rejection throws a TypeError. Both
    // are transient, so the batch layer keeps the events queued and retries on the next flush. The
    // original error rides along as `cause` so CORS/DNS/mixed-content drops aren't all logged alike.
    if (controller.signal.aborted) {
      throw new RpcError('RPC timed out', GrpcCode.DeadlineExceeded, err)
    }
    if (err instanceof TypeError) {
      throw new RpcError('network request failed', GrpcCode.Unavailable, err)
    }
    // Anything else — fromBinary on a non-proto 2xx body, the content-type guard, or a toBinary
    // bug — is PERMANENT: the identical request/response repeats on every retry. Surface it raw so
    // batch.ts's isPermanentError (non-RpcError → permanent) drops the poison instead of looping
    // every ~5s forever. This is the edge @connectrpc/connect-web used to classify for us.
    throw err
  } finally {
    clearTimeout(timer)
  }
}
