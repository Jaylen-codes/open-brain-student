// ============================================================================
// CAPTURE-YOUTUBE — paste a YouTube link, the server grabs the transcript.
// ============================================================================
// Called by the YouTube tab in your web app with { url }.
// The fetching logic (and why it tries three different routes) lives in
// ../_shared/capture.ts — worth reading the comments there.
//
// DEPLOY WITH:
//   npx supabase functions deploy capture-youtube --no-verify-jwt
// (This code checks your login itself, below.)
// ============================================================================

import { admin, corsHeaders, json, signedInUser } from '../_shared/http.ts'
import { CaptureError, captureYouTube } from '../_shared/capture.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405)

  try {
    const user = await signedInUser(req)
    if (!user) return json({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json().catch(() => ({}))
    if (!url || typeof url !== 'string') return json({ ok: false, error: 'A YouTube link is required.' }, 400)

    const saved = await captureYouTube(admin, user.id, url)
    return json({ ok: true, ...saved })
  } catch (err) {
    if (err instanceof CaptureError) return json({ ok: false, error: err.message }, 422)
    console.error('[capture-youtube] Failed:', String(err))
    return json({ ok: false, error: 'Something went wrong saving that video.' }, 500)
  }
})
