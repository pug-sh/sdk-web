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
import type { MessageInitShape } from '@bufbuild/protobuf'

/** Options passed to `track()`. `immediate` bypasses batching for priority events; `timestamp` overrides the default current-time (epoch milliseconds, e.g. `Date.now()`). */
export interface TrackOptions {
  readonly immediate?: boolean
  readonly timestamp?: number
}

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue }

export const wellKnownSchemas = Object.freeze({
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
} as const)

type WellKnownSchemas = typeof wellKnownSchemas
export type WellKnownEventName = keyof WellKnownSchemas
export type WellKnownEventPropsMap = { [K in WellKnownEventName]: MessageInitShape<WellKnownSchemas[K]> }

/**
 * Overloaded track function type. First overload narrows properties for well-known
 * events; second accepts any string with loose Record<string, JSONValue> props.
 *
 * Note: if the first overload's type check fails (e.g., wrong type for a known field),
 * TypeScript silently falls through to the second overload. Runtime validation in
 * validateWellKnownProps is the actual safety net.
 */
export type TrackFn = {
  <K extends WellKnownEventName>(
    event: K,
    props?: WellKnownEventPropsMap[K] & Record<string, JSONValue>,
    options?: TrackOptions
  ): void
  (event: string, props?: Record<string, JSONValue>, options?: TrackOptions): void
}
