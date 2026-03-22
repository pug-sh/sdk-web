export const isStorageAvailable = (storage: Storage): boolean => {
  try {
    const key = '__cotton_test__'
    storage.setItem(key, '1')
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}
