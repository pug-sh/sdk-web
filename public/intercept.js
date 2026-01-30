// Monkey-patches console.log to intercept SDK transport events.
// Must load as a classic <script> BEFORE the SDK module so we
// capture the very first page_view event.
;(function () {
  var eventQueue = []
  var uiReady = false

  var originalLog = console.log
  console.log = function () {
    originalLog.apply(console, arguments)
    if (
      arguments.length >= 2 &&
      typeof arguments[0] === 'string' &&
      arguments[0].indexOf('[CottonTransport] Sending event:') === 0
    ) {
      var eventData = arguments[1]
      if (uiReady) {
        window.__cottonRenderEvent(eventData)
      } else {
        eventQueue.push(eventData)
      }
    }
  }

  window.__cottonFlushQueue = function () {
    uiReady = true
    for (var i = 0; i < eventQueue.length; i++) {
      window.__cottonRenderEvent(eventQueue[i])
    }
    eventQueue = []
  }
})()
