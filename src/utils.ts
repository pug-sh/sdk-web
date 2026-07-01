export const DEVICE_ID_KEY = 'pug_device_id'

/** Default backend base URL used when `init()` is called without an explicit `endpoint`. */
export const DEFAULT_ENDPOINT = 'https://api.pug.sh'

export const makeStorageKey = (projectId: string, name: string): string => `__pug_${projectId}_${name}__`

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
