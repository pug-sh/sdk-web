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
  const uad = navigator.userAgentData
  if (!uad?.getHighEntropyValues) {
    return
  }

  uad.getHighEntropyValues(['platformVersion', 'model']).then(values => {
    cachedHighEntropy = {}
    if (values.platformVersion) {
      cachedHighEntropy.osVersion = values.platformVersion
    }
    if (values.model) {
      cachedHighEntropy.device = values.model
    }
  }).catch(() => {
    // Best-effort — backend fills in from UA header
  })
}

export const parseUserAgentData = (): UserAgentProps => {
  const uad = navigator.userAgentData
  if (!uad) {
    return {}
  }

  const result: UserAgentProps = {}

  const brand = uad.brands?.find(b => !b.brand.startsWith('Not'))
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
}

interface UtmParams {
  $utmSource?: string
  $utmMedium?: string
  $utmCampaign?: string
  $utmContent?: string
  $utmTerm?: string
}

export const parseUtmParams = (search: string): UtmParams => {
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
}
