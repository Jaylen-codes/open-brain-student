// ============================================================================
// CAPTURE-URL — paste an article link, the server fetches and saves its text.
// ============================================================================
// Called by the Link tab in your web app with { url }.
// The fetching logic lives in ../_shared/capture.ts.
//
// DEPLOY WITH:
//   npx supabase functions deploy capture-url --no-verify-jwt
// (This code checks your login itself, below.)
// ============================================================================

import { admin, corsHeaders, json, signedInUser } from '../_shared/http.ts'
import { CaptureError, captureUrl } from '../_shared/capture.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405)

  try {
    const user = await signedInUser(req)
    if (!user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json().catch(() => ({}))
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A web address is required.' }, 400)

    const saved = await captureUrl(admin, user.id, url)
    return json({ ok: true, ...saved })
  } catch (err) {
    if (err instanceof CaptureError) return json({ ok: false, error: err.message }, 422)
    console.error('[capture-url] Failed:', String(err))
    return json({ ok: false, error: 'Something went wrong saving that page.' }, 500)
  }
})
