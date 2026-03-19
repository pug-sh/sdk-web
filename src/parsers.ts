export type BrowserName =
  | 'Edge'
  | 'Opera'
  | 'Samsung Browser'
  | 'UC Browser'
  | 'Chrome'
  | 'Firefox'
  | 'Safari'
  | 'Other'
export type OsName = 'iOS' | 'Android' | 'Windows' | 'Mac OS X' | 'Linux' | 'Other'

export interface NavInfo {
  readonly browser: BrowserName
  readonly browserVersion: string
  readonly os: OsName
  readonly osVersion: string
  readonly deviceType: 'Desktop' | 'Mobile' | 'Tablet'
}

export interface UtmParams {
  $utmSource?: string
  $utmMedium?: string
  $utmCampaign?: string
  $utmContent?: string
  $utmTerm?: string
}

interface UABrand {
  readonly brand: string
  readonly version: string
}

export interface UAData {
  readonly brands: ReadonlyArray<UABrand>
  readonly mobile: boolean
  readonly platform: string
  readonly platformVersion?: string
  readonly fullVersionList?: ReadonlyArray<UABrand>
}

const NT_VERSION_MAP: Record<string, string> = {
  '10.0': '10',
  '6.3': '8.1',
  '6.2': '8',
  '6.1': '7',
}

const UA_BROWSER_PATTERNS: Array<[RegExp, BrowserName]> = [
  [/(?:Edg|EdgiOS|EdgA)\/([\d]+)/, 'Edge'],
  [/OPR\/([\d]+)/, 'Opera'],
  [/SamsungBrowser\/([\d]+)/, 'Samsung Browser'],
  [/UCBrowser\/([\d]+)/, 'UC Browser'],
  [/(?:Chrome|CriOS)\/([\d]+)/, 'Chrome'],
  [/(?:Firefox|FxiOS)\/([\d]+)/, 'Firefox'],
  [/Version\/([\d]+).*Safari/, 'Safari'],
]

const BRAND_PRIORITY: Array<[string, BrowserName]> = [
  ['Microsoft Edge', 'Edge'],
  ['Opera', 'Opera'],
  ['Samsung Internet', 'Samsung Browser'],
  ['Google Chrome', 'Chrome'],
  ['Chromium', 'Chrome'],
]

export const parseFromUAData = (uaData: UAData): NavInfo => {
  const brands = uaData.fullVersionList ?? uaData.brands
  let browser: BrowserName = 'Other'
  let browserVersion = ''

  for (const [brandName, browserName] of BRAND_PRIORITY) {
    const match = brands.find(b => b.brand === brandName)
    if (match) {
      browser = browserName
      browserVersion = match.version
      break
    }
  }

  let os: OsName = 'Other'
  let osVersion = ''
  let deviceType: NavInfo['deviceType'] = uaData.mobile ? 'Mobile' : 'Desktop'

  switch (uaData.platform) {
    case 'iOS':
      os = 'iOS'
      osVersion = uaData.platformVersion ?? ''
      deviceType = uaData.mobile ? 'Mobile' : 'Tablet'
      break
    case 'Android':
      os = 'Android'
      osVersion = uaData.platformVersion ?? ''
      deviceType = uaData.mobile ? 'Mobile' : 'Tablet'
      break
    case 'Windows':
      os = 'Windows'
      osVersion = uaData.platformVersion ? (parseInt(uaData.platformVersion, 10) >= 13 ? '11' : '10') : ''
      deviceType = 'Desktop'
      break
    case 'macOS':
      os = 'Mac OS X'
      osVersion = uaData.platformVersion ?? ''
      deviceType = 'Desktop'
      break
    case 'Linux':
    case 'Chrome OS':
      os = 'Linux'
      deviceType = 'Desktop'
      break
  }

  return { browser, browserVersion, os, osVersion, deviceType }
}

export const parseFromUA = (ua: string): NavInfo => {
  let browser: BrowserName = 'Other'
  let browserVersion = ''

  for (const [pattern, browserName] of UA_BROWSER_PATTERNS) {
    const m = ua.match(pattern)
    if (m) {
      browser = browserName
      browserVersion = m[1]
      break
    }
  }

  if (/iPhone|iPad|iPod/.test(ua)) {
    const m = ua.match(/OS ([\d_]+)/)
    const osVersion = m ? m[1].replace(/_/g, '.') : ''
    const deviceType = /iPad/.test(ua) ? 'Tablet' : 'Mobile'
    return { browser, browserVersion, os: 'iOS', osVersion, deviceType }
  }

  const android = ua.match(/Android ([\d.]+)/)
  if (android) {
    const deviceType = /Mobile/.test(ua) ? 'Mobile' : 'Tablet'
    return { browser, browserVersion, os: 'Android', osVersion: android[1], deviceType }
  }

  const windows = ua.match(/Windows NT ([\d.]+)/)
  if (windows) {
    return {
      browser,
      browserVersion,
      os: 'Windows',
      osVersion: NT_VERSION_MAP[windows[1]] ?? windows[1],
      deviceType: 'Desktop',
    }
  }

  const mac = ua.match(/Mac OS X ([\d_.]+)/)
  if (mac) {
    return { browser, browserVersion, os: 'Mac OS X', osVersion: mac[1].replace(/_/g, '.'), deviceType: 'Desktop' }
  }

  if (/Linux/.test(ua)) {
    return { browser, browserVersion, os: 'Linux', osVersion: '', deviceType: 'Desktop' }
  }

  return { browser, browserVersion, os: 'Other', osVersion: '', deviceType: 'Desktop' }
}

export interface NavigatorLike {
  readonly userAgent: string
  readonly userAgentData?: UAData & {
    getHighEntropyValues(hints: readonly string[]): Promise<Partial<UAData>>
  }
}

export const parseNav = async (nav: NavigatorLike): Promise<NavInfo> => {
  if (nav.userAgentData) {
    try {
      const hints = await nav.userAgentData.getHighEntropyValues(['platformVersion', 'fullVersionList'])
      const info = parseFromUAData({ ...nav.userAgentData, ...hints })
      if (info.browser !== 'Other') return info
    } catch {
      // fall through
    }
  }
  try {
    return parseFromUA(nav.userAgent)
  } catch {
    return { browser: 'Other', browserVersion: '', os: 'Other', osVersion: '', deviceType: 'Desktop' }
  }
}

export const parseUtmParams = (search: string): UtmParams => {
  const params = new URLSearchParams(search)
  const result: UtmParams = {}

  const source = params.get('utm_source')
  if (source) result.$utmSource = source

  const medium = params.get('utm_medium')
  if (medium) result.$utmMedium = medium

  const campaign = params.get('utm_campaign')
  if (campaign) result.$utmCampaign = campaign

  const content = params.get('utm_content')
  if (content) result.$utmContent = content

  const term = params.get('utm_term')
  if (term) result.$utmTerm = term

  return result
}
