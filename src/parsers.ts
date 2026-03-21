export interface UtmParams {
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
