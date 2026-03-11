const ID_LENGTH = 36

// Generates a time-sortable event ID for idempotency using Web Crypto.
// Format: base-36 timestamp (ms) prefix + hex random suffix, always 36 chars.
// crypto.getRandomValues() works without a secure context, unlike crypto.randomUUID().
export const generateId = (): string => {
  const time = Date.now().toString(36)
  const randBytes = Math.ceil((ID_LENGTH - time.length) / 2)
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(randBytes)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return (time + rand).slice(0, ID_LENGTH)
}
