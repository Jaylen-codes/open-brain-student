#!/usr/bin/osascript -l JavaScript
// ============================================================================
// ICLOUD SYNC — sends what changed in iCloud to your Open Brain.
// ============================================================================
// Runs on your Mac every 15 minutes (mac/install.sh sets that up). Each run:
//   📝 Apple Notes      changed since the last run
//   ✅ Reminders        changed since the last run (open and completed)
//   📅 Calendar         events in the next 14 days (only the ones that changed get rewritten)
//   📁 iCloud Drive     files changed in iCloud Drive/Brain  (txt, md, rtf, docx, pdf, html …)
// …and posts them to your icloud-ingest function. Editing a note later
// updates the same thought in your brain instead of creating a copy.
//
// Settings live in ~/.open-brain/config.json (install.sh writes it):
//   { "url": "https://<project>.supabase.co/functions/v1/icloud-ingest",
//     "token": "<your INGEST_TOKEN>",
//     "sources": ["notes", "reminders", "calendar", "drive"],
//     "firstRunDays": 30 }
//
// Run it by hand to test:   osascript -l JavaScript mac/icloud-sync.js
// ============================================================================
ObjC.import('Foundation')
ObjC.import('Quartz')   // PDFKit, for reading PDFs

const app = Application.currentApplication()
app.includeStandardAdditions = true

const HOME = $.NSHomeDirectory().js
const DIR = `${HOME}/.open-brain`
const CONFIG = `${DIR}/config.json`
const STATE = `${DIR}/state.json`
const DRIVE = `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Brain`
const BATCH = 40
const MAX_CHARS = 90000

const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'"
const sh = cmd => app.doShellScript(cmd, { alteringLineEndings: false })
const log = msg => console.log(`[icloud-sync ${new Date().toISOString()}] ${msg}`)

function readText(path) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null)
  return s.isNil() ? null : s.js
}
function writeText(path, text) {
  $.NSString.alloc.initWithUTF8String(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)
}
const iso = d => (d ? new Date(d).toISOString() : null)

// ---------------------------------------------------------------------------
function collectNotes(since) {
  const Notes = Application('Notes')
  const changed = Notes.notes.whose({ modificationDate: { _greaterThan: since } })()
  const items = []
  for (const n of changed) {
    try {
      const folder = n.container().name()
      if (/recently deleted/i.test(folder)) continue
      items.push({ source: 'notes', id: n.id(), title: n.name(), content: `Folder: ${folder}\n\n${n.plaintext()}`, modified: iso(n.modificationDate()) })
    } catch (e) { log('skipped a note: ' + e) }
  }
  return items
}

function collectReminders(since) {
  const R = Application('Reminders')
  const changed = R.reminders.whose({ modificationDate: { _greaterThan: since } })()
  const items = []
  for (const r of changed) {
    try {
      const due = r.dueDate()
      const lines = [
        `List: ${r.container().name()}`,
        `Status: ${r.completed() ? 'completed' : 'open'}`,
        due ? `Due: ${new Date(due).toLocaleString()}` : '',
        r.body() ? `\n${r.body()}` : '',
      ].filter(Boolean)
      items.push({ source: 'reminders', id: r.id(), title: r.name(), content: lines.join('\n'), modified: iso(r.modificationDate()) })
    } catch (e) { log('skipped a reminder: ' + e) }
  }
  return items
}

function collectCalendar() {
  const C = Application('Calendar')
  const now = new Date(), end = new Date(Date.now() + 14 * 86400000)
  const items = []
  for (const cal of C.calendars()) {
    let events = []
    try { events = cal.events.whose({ _and: [{ startDate: { _greaterThan: now } }, { startDate: { _lessThan: end } }] })() }
    catch (e) { continue }
    for (const ev of events) {
      try {
        const lines = [
          `Calendar: ${cal.name()}`,
          `When: ${new Date(ev.startDate()).toLocaleString()} – ${new Date(ev.endDate()).toLocaleString()}`,
          ev.location() ? `Where: ${ev.location()}` : '',
          ev.description() ? `\n${ev.description()}` : '',
        ].filter(Boolean)
        // The ingest function skips events whose text hasn't changed.
        items.push({ source: 'calendar', id: ev.uid(), title: ev.summary(), content: lines.join('\n'), modified: null })
      } catch (e) { log('skipped an event: ' + e) }
    }
  }
  return items
}

function fileText(path) {
  const ext = path.split('.').pop().toLowerCase()
  if (['txt', 'md', 'markdown', 'csv', 'json'].includes(ext)) return readText(path)
  if (ext === 'pdf') {
    const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(path))
    return doc.isNil() ? null : doc.string.js
  }
  if (['rtf', 'rtfd', 'doc', 'docx', 'odt', 'html', 'htm', 'webarchive', 'pages'].includes(ext)) {
    try { return sh(`/usr/bin/textutil -convert txt -stdout ${q(path)} 2>/dev/null`) } catch (e) { return null }
  }
  return null
}

function collectDrive(firstRun) {
  const exists = $.NSFileManager.defaultManager.fileExistsAtPath(DRIVE)
  if (!exists) { sh(`mkdir -p ${q(DRIVE)}`); log('created iCloud Drive/Brain — drop files there'); return [] }
  // Files newer than the state file (= changed since the last successful run)
  const newer = firstRun ? '' : `-newer ${q(STATE)}`
  const out = sh(`/usr/bin/find ${q(DRIVE)} -type f ${newer} ! -name '.*' ! -name '*.icloud' 2>/dev/null || true`).trim()
  const items = []
  for (const path of out ? out.split('\n') : []) {
    const text = fileText(path)
    if (!text || !text.trim()) { log('no readable text in ' + path); continue }
    const rel = path.slice(DRIVE.length + 1)
    items.push({ source: 'drive', id: rel, title: rel, content: text.slice(0, MAX_CHARS), modified: null })
  }
  return items
}

// ---------------------------------------------------------------------------
function send(cfg, items) {
  const tmp = `${DIR}/payload.json`
  let totals = { created: 0, updated: 0, unchanged: 0, skipped: 0 }
  for (let i = 0; i < items.length; i += BATCH) {
    writeText(tmp, JSON.stringify({ items: items.slice(i, i + BATCH) }))
    const res = sh(`/usr/bin/curl -sS --max-time 60 -X POST ${q(cfg.url)} ` +
      `-H 'Content-Type: application/json' -H ${q('Authorization: Bearer ' + cfg.token)} --data-binary @${q(tmp)}`)
    let r
    try { r = JSON.parse(res) } catch (e) { throw new Error('Unexpected reply: ' + res.slice(0, 200)) }
    if (!r.ok) throw new Error(r.error || 'ingest failed')
    for (const k in totals) totals[k] += r[k] || 0
  }
  sh(`rm -f ${q(tmp)}`)
  return totals
}

function run() {
  const raw = readText(CONFIG)
  if (!raw) { log(`No settings. Run mac/install.sh first (looks for ${CONFIG}).`); return }
  const cfg = JSON.parse(raw)
  const sources = cfg.sources || ['notes', 'reminders', 'calendar', 'drive']
  const state = JSON.parse(readText(STATE) || '{}')
  const firstRun = !state.lastRun
  const since = firstRun ? new Date(Date.now() - (cfg.firstRunDays || 30) * 86400000) : new Date(state.lastRun)
  const started = new Date()

  let items = [], failed = false
  const grab = (name, fn) => {
    if (!sources.includes(name)) return
    try { const got = fn(); items = items.concat(got); log(`${name}: ${got.length}`) }
    catch (e) { failed = true; log(`${name} failed: ${e} — check System Settings → Privacy & Security → Automation / ${name}`) }
  }
  grab('notes', () => collectNotes(since))
  grab('reminders', () => collectReminders(since))
  grab('calendar', () => collectCalendar())
  grab('drive', () => collectDrive(firstRun))

  if (items.length) log('sent → ' + JSON.stringify(send(cfg, items)))
  else log('nothing changed')
  // Only move the bookmark forward once everything was read and delivered,
  // so nothing is skipped. (Re-sending is harmless: unchanged items are ignored.)
  if (failed) { log('not advancing — will retry next run'); return }
  writeText(STATE, JSON.stringify({ lastRun: started.toISOString() }))
}

run()
