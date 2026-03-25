export const makeStorageKey = (projectId: string, name: string): string => `__cotton_${projectId}_${name}__`

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
