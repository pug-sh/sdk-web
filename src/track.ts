import {
  AddToCartPropertiesSchema,
  AppClosePropertiesSchema,
  AppOpenPropertiesSchema,
  CheckoutCompletedPropertiesSchema,
  CheckoutStartedPropertiesSchema,
  ClickPropertiesSchema,
  DeadClickPropertiesSchema,
  ErrorOccurredPropertiesSchema,
  FormStartPropertiesSchema,
  FormSubmitPropertiesSchema,
  LoginPropertiesSchema,
  LogoutPropertiesSchema,
  NotificationClickedPropertiesSchema,
  NotificationDismissedPropertiesSchema,
  NotificationReceivedPropertiesSchema,
  PageViewPropertiesSchema,
  PurchasePropertiesSchema,
  RageClickPropertiesSchema,
  ScrollPropertiesSchema,
  SearchPropertiesSchema,
  SharePropertiesSchema,
  SignupPropertiesSchema,
  VideoPausePropertiesSchema,
  VideoPlayPropertiesSchema,
} from '@buf/fivebits_cotton.bufbuild_es/common/v1/well_known_events_pb.js'
import { type Event, EventSchema } from '@buf/fivebits_cotton.bufbuild_es/sdk/events/v1/events_pb.js'
import { create, toJson, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf'
import { timestampFromMs, timestampNow } from '@bufbuild/protobuf/wkt'
import { createValidator } from '@bufbuild/protovalidate'
import { log } from './logger.js'
import { parseUserAgentData, parseUtmParams } from './parsers.js'
import { SDK_VERSION } from './version.js'

const validator = createValidator()

/** Options passed to `track()`. `immediate` bypasses batching for priority events; `timestamp` overrides the default current-time (epoch milliseconds, e.g. `Date.now()`). */
export interface TrackOptions {
  readonly immediate?: boolean
  readonly timestamp?: number
}

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }

const wellKnownSchemas = {
  add_to_cart: AddToCartPropertiesSchema,
  app_close: AppClosePropertiesSchema,
  app_open: AppOpenPropertiesSchema,
  checkout_completed: CheckoutCompletedPropertiesSchema,
  checkout_started: CheckoutStartedPropertiesSchema,
  click: ClickPropertiesSchema,
  dead_click: DeadClickPropertiesSchema,
  error_occurred: ErrorOccurredPropertiesSchema,
  form_start: FormStartPropertiesSchema,
  form_submit: FormSubmitPropertiesSchema,
  login: LoginPropertiesSchema,
  logout: LogoutPropertiesSchema,
  notification_clicked: NotificationClickedPropertiesSchema,
  notification_dismissed: NotificationDismissedPropertiesSchema,
  notification_received: NotificationReceivedPropertiesSchema,
  page_view: PageViewPropertiesSchema,
  purchase: PurchasePropertiesSchema,
  rage_click: RageClickPropertiesSchema,
  scroll: ScrollPropertiesSchema,
  search: SearchPropertiesSchema,
  share: SharePropertiesSchema,
  signup: SignupPropertiesSchema,
  video_pause: VideoPausePropertiesSchema,
  video_play: VideoPlayPropertiesSchema,
} as const

type WellKnownSchemas = typeof wellKnownSchemas
export type WellKnownEventName = keyof WellKnownSchemas
export type WellKnownEventPropsMap = { [K in WellKnownEventName]: MessageInitShape<WellKnownSchemas[K]> }

export type TrackProps<K extends string> = K extends WellKnownEventName
  ? WellKnownEventPropsMap[K]
  : Record<string, JSONValue>

export type TrackFn = {
  <K extends WellKnownEventName>(event: K, props?: WellKnownEventPropsMap[K] & Record<string, JSONValue>, options?: TrackOptions): void
  (event: string, props?: Record<string, JSONValue>, options?: TrackOptions): void
}

const validateWellKnownProps = <Desc extends DescMessage>(
  schema: Desc,
  data: Record<string, unknown>
): Record<string, JSONValue> | null => {
  const knownNames = new Set(schema.fields.map(f => f.localName))
  const knownData: Record<string, unknown> = {}
  const extraData: Record<string, JSONValue> = {}
  for (const [k, v] of Object.entries(data)) {
    if (knownNames.has(k)) {
      knownData[k] = v
    } else {
      extraData[k] = v as JSONValue
    }
  }
  const msg = create(schema, knownData as MessageInitShape<Desc>)
  const result = validator.validate(schema, msg)
  if (result.kind === 'invalid') {
    log.error(
      `Properties validation failed for "${schema.typeName}":`,
      result.violations.map(v => `${v.field}: ${v.message}`).join(', ')
    )
    return null
  }
  return { ...(toJson(schema, msg) as Record<string, JSONValue>), ...extraData }
}

const flattenJSONValue = (props: Record<string, JSONValue>) => {
  const m: Record<string, string> = {}
  for (const k of Object.keys(props)) {
    m[k] = typeof props[k] === 'string' ? props[k] : JSON.stringify(props[k])
  }
  return m
}

export const toEvent = (
  projectId: string,
  kind: string,
  sessionId: string,
  distinctId: string,
  props?: Record<string, unknown>,
  opts?: TrackOptions
): Event | null => {
  let resolvedProps: Record<string, JSONValue> | undefined

  if (kind in wellKnownSchemas) {
    const schema = wellKnownSchemas[kind as WellKnownEventName]
    resolvedProps = validateWellKnownProps(schema, props as MessageInitShape<typeof schema>) ?? undefined
    if (resolvedProps === undefined && props !== undefined) return null
  } else {
    resolvedProps = props as Record<string, JSONValue>
  }

  const event = create(EventSchema, {
    autoProperties: {
      $projectId: projectId,
      $url: window.location.href,
      $referrer: document.referrer,
      $locale: navigator.language,
      $screenWidth: String(window.screen.width),
      $screenHeight: String(window.screen.height),
      $pageTitle: document.title,
      $sdkVersion: SDK_VERSION,
      ...parseUserAgentData(),
      ...parseUtmParams(window.location.search),
    },
    customProperties: resolvedProps ? flattenJSONValue(resolvedProps) : {},
    kind,
    sessionId,
    distinctId,
    occurTime: opts?.timestamp ? timestampFromMs(opts.timestamp) : timestampNow(),
  })

  const result = validator.validate(EventSchema, event)
  if (result.kind === 'invalid') {
    log.error(`Event "${kind}" failed validation:`, result.violations.map(v => `${v.field}: ${v.message}`).join(', '))
    return null
  }

  return event
}
