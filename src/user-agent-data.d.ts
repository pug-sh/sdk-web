interface NavigatorUABrandVersion {
  readonly brand: string
  readonly version: string
}

interface UADataValues {
  readonly platformVersion?: string
  readonly model?: string
}

interface NavigatorUAData {
  readonly brands: NavigatorUABrandVersion[]
  readonly mobile: boolean
  readonly platform: string
  getHighEntropyValues(hints: string[]): Promise<UADataValues>
}

interface Navigator {
  readonly userAgentData?: NavigatorUAData
  /** Global Privacy Control. Non-standard, so absent on most browsers. */
  readonly globalPrivacyControl?: boolean
}
