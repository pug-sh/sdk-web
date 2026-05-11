export type TrackingConsentStatus = 'granted' | 'denied'

export const createTrackingConsent = (optedOutByDefault: boolean) => {
  let status: TrackingConsentStatus = optedOutByDefault ? 'denied' : 'granted'

  return {
    getStatus: (): TrackingConsentStatus => status,
    hasOptedIn: (): boolean => status === 'granted',
    optIn: (): void => {
      status = 'granted'
    },
    optOut: (): void => {
      status = 'denied'
    },
  }
}

export type TrackingConsentController = ReturnType<typeof createTrackingConsent>
