export type TrackingConsent = 'granted' | 'denied'

export const createTrackingConsent = (defaultConsent: TrackingConsent = 'granted') => {
  let status: TrackingConsent = defaultConsent

  return {
    getConsent: (): TrackingConsent => status,
    isGranted: (): boolean => status === 'granted',
    optIn: (): void => {
      status = 'granted'
    },
    optOut: (): void => {
      status = 'denied'
    },
  }
}

export type TrackingConsentController = ReturnType<typeof createTrackingConsent>
