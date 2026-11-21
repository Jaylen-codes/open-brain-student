// ============================================================================
// ICLOUD-INGEST — Apple Notes, Reminders, Calendar and iCloud Drive → brain.
// ============================================================================
// iCloud has no door that outside servers can knock on, so your Mac knocks
// instead: mac/icloud-sync.js (run every 15 minutes by mac/install.sh) reads
// what changed and sends it here. An Apple Shortcut on your iPhone can send
// here too — see command-center/SETUP.md.
//
// Each item is keyed by where it came from ("icloud:notes:<id>"), so editing a
// note UPDATES its thought instead of creating a duplicate — and the updated
// text is re-tagged and re-mapped for search.
//
// Send:   POST  Authorization: Bearer <INGEST_TOKEN>
//         { "items": [ { "source": "notes", "id": "...", "title": "...",
//                        "content": "...", "modified": "2026-11-21T10:00:00Z" } ] }
//         source: notes | reminders | calendar | drive | shortcut
//
// DEPLOY WITH:
//   npx supabase functions deploy icloud-ingest --no-verify-jwt
//   npx supabase secrets set INGEST_TOKEN=<a long random password>
// (OWNER_USER_ID is already set from Level 5.)
// ============================================================================

import { admin, corsHeaders, json } from '../_shared/http.ts'

const INGEST_TOKEN = Deno.env.get('INGEST_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const MAX_ITEMS = 50
const MAX_CHARS = 100_000

const ICON: Record<string, string> = { notes: '📝', reminders: '✅', calendar: '📅', drive: '📁', shortcut: '📲' }

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function reEnrich(id: string) {
  const call = fetch(`${SUPABASE_URL}/functions/v1/enrich-thought`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
  }).catch(err => console.warn('[ingest] re-enrich failed:', String(err)))
  // deno-lint-ignore no-explicit-any
  ;(globalThis as any).EdgeRuntime?.waitUntil?.(call)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405)
  if (!INGEST_TOKEN || INGEST_TOKEN.length < 24 || !OWNER_USER_ID) {
    return json({ ok: false, error: 'Set INGEST_TOKEN (24+ characters) and OWNER_USER_ID in Supabase secrets.' }, 503)
  }
  const auth = req.headers.get('Authorization') ?? ''
  if (!safeEqual(auth, `Bearer ${INGEST_TOKEN}`)) return json({ ok: false, error: 'Wrong token' }, 401)

  try {
    const body = await req.json().catch(() => ({}))
    const items = (Array.isArray(body.items) ? body.items : [body]).slice(0, MAX_ITEMS)
    let created = 0, updated = 0, unchanged = 0, skipped = 0

    for (const it of items) {
      const source = String(it?.source ?? 'shortcut').toLowerCase()
      const extId = String(it?.id ?? '').slice(0, 300)
      const title = String(it?.title ?? '').trim().slice(0, 300)
      const text = String(it?.content ?? '').trim()
      if (!ICON[source] || (!text && !title)) { skipped++; continue }

      const content = `${ICON[source]} ${title || 'Untitled'}\n\n${text}`.slice(0, MAX_CHARS)
      // No id (a quick Shortcut capture) → plain content dedup, like the app.
      const key = extId ? `icloud:${source}:${extId}` : null
      const metadata = { source: `icloud-${source}`, external_id: extId || null, title, modified: it?.modified ?? null }

      if (key) {
        const { data: existing } = await admin.from('thoughts').select('id, content')
          .eq('user_id', OWNER_USER_ID).eq('dedup_key', key).maybeSingle()
        if (existing) {
          if (existing.content === content) { unchanged++; continue }
          const { error } = await admin.from('thoughts').update({
            content, metadata, embedding: null, enriched_at: null,
          }).eq('id', existing.id)
          if (error) throw error
          // Old search pieces describe the old text — clear them so they're rebuilt.
          await admin.from('thought_chunks').delete().eq('thought_id', existing.id)
          reEnrich(existing.id)
          updated++
          continue
        }
      }
      const { error } = await admin.from('thoughts').upsert(
        { user_id: OWNER_USER_ID, content, metadata, ...(key ? { dedup_key: key } : {}) },
        { onConflict: 'dedup_key,user_id', ignoreDuplicates: true })
      if (error) throw error
      created++   // the insert trigger tags and maps it
    }

    return json({ ok: true, created, updated, unchanged, skipped })
  } catch (err) {
    console.error('[ingest] Failed:', err instanceof Error ? err.message : String(err))
    return json({ ok: false, error: 'Ingest failed — see logs.' }, 500)
  }
})
