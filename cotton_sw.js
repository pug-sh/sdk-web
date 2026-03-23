self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', event => event.waitUntil(clients.claim()))

self.addEventListener('push', event => {
  const data = event.data.json()
  event.waitUntil(self.registration.showNotification(data.title, data.options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const data = event.notification.data ?? {}
  const targetUrl = data.url ?? '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      if (windowClients.length > 0) {
        // Page is already open — notify it directly via postMessage
        for (const client of windowClients) {
          client.postMessage({ type: 'cotton_notification_click', data })
        }
        return windowClients[0].focus()
      }
      // No open page — encode notification data in URL so the page can track on load
      const url = new URL(targetUrl, self.location.origin)
      url.searchParams.set('cotton_nc', JSON.stringify(data))
      return clients.openWindow(url.toString())
    }),
  )
})
