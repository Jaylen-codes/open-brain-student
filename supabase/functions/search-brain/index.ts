// ============================================================================
// SEARCH-BRAIN — the web app's Search tab: by meaning, plus exact words.
// ============================================================================
// The browser can't turn a question into meaning coordinates itself, so the
// app sends the question here with your login, and this function searches
// only YOUR thoughts.
//
// DEPLOY WITH:
//   npx supabase functions deploy search-brain --no-verify-jwt
// (This code checks your login itself, below.)
// ============================================================================

import { admin, corsHeaders, json, signedInUser } from '../_shared/http.ts'
import { searchBrain } from '../_shared/search.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405)

  try {
    const user = await signedInUser(req)
    if (!user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { query, limit } = await req.json().catch(() => ({}))
    const q = String(query ?? '').trim()
    if (!q) return json({ ok: false, error: 'Type something to search for.' }, 400)

    const n = Math.min(Math.max(Math.floor(Number(limit) || 20), 1), 50)
    const results = await searchBrain(admin, user.id, q.slice(0, 500), n)
    return json({ ok: true, results })
  } catch (err) {
    console.error('[search-brain] Failed:', err instanceof Error ? err.message : String(err))
    return json({ ok: false, error: 'Search failed. Try again in a moment.' }, 500)
  }
})
