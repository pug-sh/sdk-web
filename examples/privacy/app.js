// Privacy controls example — `data-pug-no-capture` + `sanitizeUrl`.
//
// Run from the repo root:
//   bun run build && bun run serve
// then open http://localhost:3000/examples/privacy/
//
// The SDK is initialized in dryRun mode so this page never sends anything. The
// URL panel reuses the exact maskUrl passed to init({ sanitizeUrl }); the capture
// panel reimplements the SDK's internal suppression check (data-pug-no-capture
// takes no function) so you can see its effect on sample inputs.

import { init } from '../../dist/index.js'

// ── 1. URL sanitizer: route masking + PII query-param stripping ──
//
// Turns /orders/12345 → /orders/:orderId and drops sensitive query params.
// The SDK can't know your routes, so the pattern list lives here, in your app.
const ROUTE_PATTERNS = [
  [/\/orders\/\d+/g, '/orders/:orderId'],
  [/\/users\/[0-9a-f-]{36}/g, '/users/:userId'],
  [/\/invoices\/[A-Z0-9-]+/g, '/invoices/:invoiceId'],
]
const STRIP_PARAMS = ['email', 'token', 'name']

const maskUrl = url => {
  let u
  try {
    u = new URL(url, window.location.origin)
  } catch {
    return '' // unparseable → fail closed rather than leak
  }
  for (const [pattern, replacement] of ROUTE_PATTERNS) {
    u.pathname = u.pathname.replace(pattern, replacement)
  }
  for (const param of STRIP_PARAMS) {
    u.searchParams.delete(param)
  }
  return u.toString()
}

// ── 2. Initialize the SDK with both privacy controls wired in ──
//
// `data-pug-no-capture` (in index.html) needs no config — the click and
// dead-click trackers consult it automatically. `sanitizeUrl` is opt-in here.
init('privacy-example', {
  apiKey: 'demo-api-key', // required by init(); unused here since dryRun never delivers
  dryRun: true, // demo only — never deliver
  sanitizeUrl: maskUrl,
})

// ── Visualization (mirrors the functions above; not part of the SDK) ──

const SAMPLE_URLS = [
  'https://shop.example.com/orders/12345?ref=email',
  'https://shop.example.com/users/4f1d2c3b-1111-2222-3333-444455556666',
  'https://shop.example.com/invoices/INV-2026-042?token=abc123',
  'https://shop.example.com/reset?email=jane@example.com&name=Jane',
  'https://shop.example.com/pricing',
]

const renderUrlTable = () => {
  const rows = SAMPLE_URLS.map(raw => {
    const masked = maskUrl(raw)
    return `<tr><td class="raw">${raw}</td><td class="arrow">→</td><td class="masked">${masked}</td></tr>`
  }).join('')
  document.getElementById('url-table').innerHTML = rows
}

// Mirrors utils.isCaptureSuppressed so the page can show, per click, whether the
// SDK would have redacted the element's text.
const isSuppressed = el => !!el?.closest('[data-pug-no-capture]')

const logEl = document.getElementById('capture-log')
const logClick = target => {
  const suppressed = isSuppressed(target)
  const text = target.innerText?.substring(0, 50) ?? '' // 50 mirrors click.ts's capture length

  // Built with DOM/text APIs, never innerHTML: `text` is page-derived and must never be parsed as
  // markup. A privacy example should model safe handling of captured content, not an XSS foot-gun.
  const entry = document.createElement('div')
  entry.className = `log-entry ${suppressed ? 'redacted' : 'captured'}`

  const tag = document.createElement('code')
  tag.textContent = `<${target.tagName.toLowerCase()}>`

  const value = document.createElement('span')
  value.className = suppressed ? 'tag' : 'val'
  value.textContent = suppressed ? '"" (redacted)' : `"${text}"`

  entry.append(tag, document.createTextNode(' text → '), value)
  logEl.prepend(entry)
}

document.addEventListener('click', e => {
  if (e.target instanceof HTMLElement && e.target.closest('.capture-zone')) {
    logClick(e.target)
  }
})

renderUrlTable()
