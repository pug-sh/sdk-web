import { init } from '../dist/index.js'
init('test-project', { endpoint: 'http://localhost:9000' })

// ── Event Log Rendering (Shadow DOM) ──

const logBody = document.getElementById('log-body')
const logEmpty = document.getElementById('log-empty')
const eventCountEl = document.getElementById('event-count')
const pauseBtn = document.getElementById('log-pause')
const clearBtn = document.getElementById('log-clear')

let eventCount = 0
let paused = false
let pauseQueue = []

// Shadow DOM host — mutations inside are invisible to the outer MutationObserver
const shadowHost = document.createElement('div')
logBody.appendChild(shadowHost)
const shadow = shadowHost.attachShadow({ mode: 'open' })

// Inject styles into shadow root
const shadowStyle = document.createElement('style')
shadowStyle.textContent = `
  :host { display: block; }
  .entry {
    padding: 10px 12px;
    border-bottom: 1px solid #3b3b3b;
    font-size: 0.875rem;
    font-family: -apple-system, "system-ui", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #c9c9c9;
    animation: fadeIn 0.15s ease;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .entry-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .event-badge {
    font-size: 0.7rem;
    padding: 1px 8px;
    border-radius: 2px;
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
    color: #fff;
  }
  .ts {
    font-size: 0.75rem;
    color: #828282;
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
    margin-left: auto;
  }
  .props {
    font-family: 'SF Mono', SFMono-Regular, Consolas, monospace;
    font-size: 0.8rem;
    color: #828282;
    line-height: 1.6;
  }
  .prop-key { color: #7aabcf; }
  .prop-val { color: #c9c9c9; }
`
shadow.appendChild(shadowStyle)

const entryContainer = document.createElement('div')
shadow.appendChild(entryContainer)

const BADGE_COLORS = {
  page_view: { bg: '#538892' },
  click: { bg: '#4d7398' },
  rage_click: { bg: '#a65966' },
  dead_click: { bg: '#ac7853' },
  scroll: { bg: '#7b598d' },
  form_start: { bg: '#4d806f' },
  form_submit: { bg: '#678353' },
}

// Properties to filter out (noise)
const NOISE_KEYS = new Set(['projectId', 'url', 'referrer', 'userAgent'])

function renderEvent(eventData) {
  if (paused) {
    pauseQueue.push(eventData)
    return
  }

  eventCount++
  eventCountEl.textContent = eventCount
  logEmpty.style.display = 'none'

  const name = eventData.eventName
  const colors = BADGE_COLORS[name] || { bg: '#868e96' }
  const ts = new Date(eventData.timestamp)
  const timeStr =
    ts.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(ts.getMilliseconds()).padStart(3, '0')

  // Filter properties
  const props = {}
  if (eventData.properties) {
    for (const [k, v] of Object.entries(eventData.properties)) {
      if (!NOISE_KEYS.has(k)) props[k] = v
    }
  }

  const entry = document.createElement('div')
  entry.className = 'entry'

  let propsHtml = ''
  for (const [k, v] of Object.entries(props)) {
    propsHtml += `<span class="prop-key">${esc(k)}</span>: <span class="prop-val">${esc(String(v))}</span>  `
  }

  entry.innerHTML = `
    <div class="entry-header">
      <span class="event-badge" style="background:${colors.bg}">${esc(name)}</span>
      <span class="ts">${timeStr}</span>
    </div>
    ${propsHtml ? `<div class="props">${propsHtml}</div>` : ''}
  `

  entryContainer.appendChild(entry)
  shadowHost.parentElement.scrollTop = shadowHost.parentElement.scrollHeight
}

function esc(s) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

// Expose to the classic script's interceptor
window.__cottonRenderEvent = renderEvent
window.__cottonFlushQueue()

// ── Log Controls ──

pauseBtn.addEventListener('click', () => {
  paused = !paused
  pauseBtn.textContent = paused ? 'resume' : 'pause'
  pauseBtn.classList.toggle('active', paused)
  if (!paused) {
    for (const ev of pauseQueue) renderEvent(ev)
    pauseQueue = []
  }
  document.title = 'Cotton SDK Test' // DOM mutation to avoid dead click
})

clearBtn.addEventListener('click', () => {
  entryContainer.innerHTML = ''
  eventCount = 0
  eventCountEl.textContent = '0'
  logEmpty.style.display = ''
  document.title = 'Cotton SDK Test' // DOM mutation to avoid dead click
})

// ── Test Interactions ──

// 1. Click tracking
let clickCount = 0
document.getElementById('test-click').addEventListener('click', () => {
  clickCount++
  document.getElementById('click-count').textContent = `${clickCount} clicks`
  document.title = `Click ${clickCount}` // DOM mutation
})

// dead-zone has no handler — that's the point

// 3. Form tracking
const testForm = document.getElementById('test-form')
const formStatus = document.getElementById('form-status')

testForm.addEventListener('submit', e => {
  e.preventDefault()
  formStatus.textContent = 'Submitted! (prevented navigation)'
  document.title = 'Form Submitted'
  setTimeout(() => {
    formStatus.textContent = ''
  }, 2000)
})
