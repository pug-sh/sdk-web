export interface BrowserInfo {
  browser: string
  browserVersion: string
}

export interface OsInfo {
  os: string
  osVersion: string
  deviceType: 'Desktop' | 'Mobile' | 'Tablet'
}

export interface UtmParams {
  $utmSource?: string
  $utmMedium?: string
  $utmCampaign?: string
  $utmContent?: string
  $utmTerm?: string
}

export const parseBrowser = (ua: string): BrowserInfo => {
  let m: RegExpMatchArray | null

  m = ua.match(/(?:Edg|EdgiOS|EdgA)\/([\d]+)/)
  if (m) return { browser: 'Edge', browserVersion: m[1] }

  m = ua.match(/OPR\/([\d]+)/)
  if (m) return { browser: 'Opera', browserVersion: m[1] }

  m = ua.match(/SamsungBrowser\/([\d]+)/)
  if (m) return { browser: 'Samsung Browser', browserVersion: m[1] }

  m = ua.match(/UCBrowser\/([\d]+)/)
  if (m) return { browser: 'UC Browser', browserVersion: m[1] }

  m = ua.match(/(?:Chrome|CriOS)\/([\d]+)/)
  if (m) return { browser: 'Chrome', browserVersion: m[1] }

  m = ua.match(/(?:Firefox|FxiOS)\/([\d]+)/)
  if (m) return { browser: 'Firefox', browserVersion: m[1] }

  m = ua.match(/Version\/([\d]+).*Safari/)
  if (m) return { browser: 'Safari', browserVersion: m[1] }

  return { browser: 'Other', browserVersion: '' }
}

const NT_VERSION_MAP: Record<string, string> = {
  '10.0': '10',
  '6.3': '8.1',
  '6.2': '8',
  '6.1': '7',
}

export const parseOs = (ua: string): OsInfo => {
  let m: RegExpMatchArray | null

  if (/iPhone|iPad|iPod/.test(ua)) {
    m = ua.match(/OS ([\d_]+)/)
    const osVersion = m ? m[1].replace(/_/g, '.') : ''
    const deviceType = /iPad/.test(ua) ? 'Tablet' : 'Mobile'
    return { os: 'iOS', osVersion, deviceType }
  }

  m = ua.match(/Android ([\d.]+)/)
  if (m) {
    const deviceType = /Mobile/.test(ua) ? 'Mobile' : 'Tablet'
    return { os: 'Android', osVersion: m[1], deviceType }
  }

  m = ua.match(/Windows NT ([\d.]+)/)
  if (m) {
    const osVersion = NT_VERSION_MAP[m[1]] ?? m[1]
    return { os: 'Windows', osVersion, deviceType: 'Desktop' }
  }

  m = ua.match(/Mac OS X ([\d_.]+)/)
  if (m) {
    return { os: 'Mac OS X', osVersion: m[1].replace(/_/g, '.'), deviceType: 'Desktop' }
  }

  if (/Linux/.test(ua)) {
    return { os: 'Linux', osVersion: '', deviceType: 'Desktop' }
  }

  return { os: 'Other', osVersion: '', deviceType: 'Desktop' }
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
