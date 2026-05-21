import { log } from './logger.js'

interface UserAgentProps {
  $browser?: string
  $browserVersion?: string
  $os?: string
  $osVersion?: string
  $device?: string
  $mobile?: string
}

let cachedHighEntropy: { osVersion?: string; device?: string } | null = null

export const initUserAgentData = () => {
  cachedHighEntropy = null
  const uad = navigator.userAgentData
  if (!uad?.getHighEntropyValues) {
    return
  }

  uad
    .getHighEntropyValues(['platformVersion', 'model'])
    .then(values => {
      cachedHighEntropy = {}
      if (values.platformVersion) {
        cachedHighEntropy.osVersion = values.platformVersion
      }
      if (values.model) {
        cachedHighEntropy.device = values.model
      }
    })
    .catch((err: unknown) => {
      log.warn('High-entropy UA data unavailable:', err)
    })
}

export const parseUserAgentData = (): UserAgentProps => {
  try {
    const uad = navigator.userAgentData
    if (!uad) {
      return {}
    }

    const result: UserAgentProps = {}

    const brand = uad.brands
      ?.slice()
      .reverse()
      .find(b => !b.brand.toLowerCase().startsWith('not'))
    if (brand) {
      result.$browser = brand.brand
      result.$browserVersion = brand.version
    }

    if (uad.platform) {
      result.$os = uad.platform
    }

    if (cachedHighEntropy?.osVersion) {
      result.$osVersion = cachedHighEntropy.osVersion
    }

    if (cachedHighEntropy?.device) {
      result.$device = cachedHighEntropy.device
    }

    result.$mobile = String(uad.mobile)

    return result
  } catch (err) {
    log.warn('Failed to parse user agent data:', err)
    return {}
  }
}

interface UtmParams {
  $utmSource?: string
  $utmMedium?: string
  $utmCampaign?: string
  $utmContent?: string
  $utmTerm?: string
}

export const parseUtmParams = (search: string): UtmParams => {
  try {
    const params = new URLSearchParams(search)
    const result: UtmParams = {}

    const source = params.get('utm_source')
    if (source) {
      result.$utmSource = source
    }

    const medium = params.get('utm_medium')
    if (medium) {
      result.$utmMedium = medium
    }

    const campaign = params.get('utm_campaign')
    if (campaign) {
      result.$utmCampaign = campaign
    }

    const content = params.get('utm_content')
    if (content) {
      result.$utmContent = content
    }

    const term = params.get('utm_term')
    if (term) {
      result.$utmTerm = term
    }

    return result
  } catch (err) {
    log.warn('Failed to parse UTM params:', err)
    return {}
  }
}
