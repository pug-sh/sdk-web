self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => event.waitUntil(clients.claim()))

self.addEventListener('push', event => {
  let data
  try {
    data = event.data?.json()
  } catch (err) {
    console.error('[Cotton SW] Failed to parse push payload:', err)
    return
  }
  if (!data || !data.title) {
    console.warn('[Cotton SW] Push payload missing required "title" field, ignoring')
    return
  }
  event.waitUntil(self.registration.showNotification(data.title, data.options ?? {}))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const data = event.notification.data ?? {}
  const targetUrl = data.url ?? '/'

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        if (windowClients.length > 0) {
          // Only notify the tab being focused — avoids duplicate notification_click events
          const target = windowClients[0]
          target.postMessage({ type: 'cotton_notification_click', data })
          return target.focus().catch(err => {
            console.warn('[Cotton SW] Could not focus existing window:', err)
          })
        }
        // No open page — encode notification data in URL so the page can track on load
        try {
          const url = new URL(targetUrl, self.location.origin)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            console.warn('[Cotton SW] Refusing to open non-HTTP URL:', targetUrl)
            return clients.openWindow('/')
          }
          url.searchParams.set('cotton_nc', JSON.stringify(data))
          return clients.openWindow(url.toString())
        } catch (err) {
          console.error('[Cotton SW] Failed to open window for notification click:', err)
          return clients.openWindow('/')
        }
      })
      .catch(err => {
        console.error('[Cotton SW] notificationclick handler failed:', err)
      }),
  )
})
