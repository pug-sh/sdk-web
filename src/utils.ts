export const DEVICE_ID_KEY = 'pug_device_id'

/**
 * Reserved by the server for the daily-rotating ids it derives for cookieless events, enforced by
 * the `batch.distinct_id_reserved_prefix` CEL rule over the whole BatchCreateRequest.
 *
 * Shared by `identify()` (which rejects it as input) and `configureProfile()` (which rejects it on
 * restore): a device poisoned before the input check existed would otherwise keep replaying it.
 */
export const RESERVED_DISTINCT_ID_PREFIX = 'cookieless-'

/** Default backend base URL used when `init()` is called without an explicit `endpoint`. */
export const DEFAULT_ENDPOINT = 'https://api.pugs.dev'

export const makeStorageKey = (projectId: string, name: string): string => `__pug_${projectId}_${name}__`

/**
 * True when `el` or any ancestor carries the `data-pug-no-capture` attribute. Integrators mark
 * sensitive regions of their DOM with it; the click and dead-click trackers consult this to redact
 * captured element text. Marking a container covers everything inside it (resolved via `closest`).
 * `getSafeElementText` reads own text nodes only, so the marker is only needed where the sensitive
 * value sits directly in an element that can itself be the click target.
 *
 * Scope: only the captured free *text* is redacted. Structural fields (`id`, `class`, `tag`,
 * coordinates) are still sent so the interaction keeps counting, so keep PII out of `id`/`class`.
 */
export const isCaptureSuppressed = (el: Element | null): boolean => !!el?.closest('[data-pug-no-capture]')

/**
 * `<textarea>` content is a child text node and `contenteditable` is user input; both are skipped.
 * `contenteditable` is inherited and editors put it on a root the pointer never hits, so this walks
 * to the nearest declaring ancestor. Not `isContentEditable` — jsdom leaves it undefined.
 */
const holdsUserEnteredText = (el: Element): boolean => {
  if (el.tagName === 'TEXTAREA') {
    return true
  }
  const editableHost = el.closest('[contenteditable]')
  return editableHost !== null && editableHost.getAttribute('contenteditable') !== 'false'
}

/**
 * The element's own text, capped at `maxLength` — direct child text nodes only, never the subtree.
 *
 * `innerText`/`textContent` return every descendant's text, so a click on a card wrapping a name or
 * an email sent all of it, and a `data-pug-no-capture` marker on the sensitive leaf did not help
 * because the read happened at the ancestor the pointer actually hit.
 */
export const getSafeElementText = (el: Element | null, maxLength: number): string => {
  if (!el || isCaptureSuppressed(el) || holdsUserEnteredText(el)) {
    return ''
  }
  let text = ''
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      // Collapse as we go so the bail is exact: appending never touches the trimmed prefix already
      // counted, so once that reaches the cap the result is frozen.
      text = `${text}${node.nodeValue ?? ''}`.replace(/\s+/g, ' ')
      if (text.trim().length >= maxLength) {
        break
      }
    }
  }
  // trimEnd after the cut — truncating mid-gap would otherwise re-expose interior whitespace.
  return text.trim().substring(0, maxLength).trimEnd()
}

export const urlBase64ToUint8Array = (base64String: string): Uint8Array<ArrayBuffer> => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const bytes = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    bytes[i] = rawData.charCodeAt(i)
  }
  return bytes
}

export const isStorageAvailable = (): boolean => {
  try {
    const s = localStorage
    const key = makeStorageKey('_', 'probe')
    s.setItem(key, '1')
    s.removeItem(key)
    return true
  } catch {
    return false
  }
}
