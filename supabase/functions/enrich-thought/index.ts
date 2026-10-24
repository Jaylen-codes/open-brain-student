// ============================================================================
// ENRICH-THOUGHT — the tagging agent.
// ============================================================================
// Runs automatically every time a new thought is saved (a database trigger
// calls it — see the Level 5 SQL). It asks the AI, through the LLM gateway,
// for 3–5 tags, a category and a one-sentence summary, and writes them back.
//
// DEPLOY WITH:
//   npx supabase functions deploy enrich-thought --no-verify-jwt
//
// Why no login check: the caller only ever sends a thought's id. This code
// loads the thought itself, and only enriches thoughts that haven't been
// enriched yet. Thought ids are random and unguessable, so a stranger calling
// this can't read anything, change anything you wrote, or run up your bill.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLM, parseJsonObject } from '../_shared/llm.ts'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection']
const MAX_CHARS_TO_AI = 12_000   // a long transcript only needs its opening to be tagged well

const SYSTEM = 'You organize notes in a personal knowledge base. Reply with JSON only.'

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  // Always answer 200 — a failed enrichment must never look like a failed save.
  try {
    const body = await req.json().catch(() => ({}))
    // Accepts { id } from our trigger, or a Supabase webhook's { record: { id } }
    const id = String(body?.id ?? body?.record?.id ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(id)) return ok({ skipped: 'no thought id' })

    const { data: t, error } = await db.from('thoughts')
      .select('id, content, user_id, category, enriched_at')
      .eq('id', id).maybeSingle()
    if (error) throw error
    if (!t) return ok({ skipped: 'not found' })
    if (t.enriched_at) return ok({ skipped: 'already enriched' })
    if (t.category === 'digest') return ok({ skipped: 'digest' })
    if ((t.content ?? '').trim().length < 20) return ok({ skipped: 'too short' })

    const { text } = await callLLM({
      systemPrompt: SYSTEM,
      prompt:
        'Read this note and reply with a JSON object with exactly these keys:\n' +
        '  "tags": 3 to 5 short lowercase tags (one or two words each),\n' +
        `  "category": one of ${CATEGORIES.map(c => `"${c}"`).join(', ')},\n` +
        '  "summary": one sentence describing what the note is about.\n' +
        'Write the tags and summary in the same language as the note.\n\n' +
        '<note>\n' + t.content.slice(0, MAX_CHARS_TO_AI) + '\n</note>',
      maxTokens: 2000,
      userId: t.user_id ?? undefined,
      source: 'enrich-thought',
    })

    const out = parseJsonObject(text)
    const tags = (Array.isArray(out.tags) ? out.tags : [])
      .map((x: unknown) => String(x).toLowerCase().trim().slice(0, 40))
      .filter(Boolean).slice(0, 5)
    const category = CATEGORIES.includes(String(out.category).toLowerCase()) ? String(out.category).toLowerCase() : 'reference'
    const summary = String(out.summary ?? '').trim().slice(0, 400) || null

    const { error: upErr } = await db.from('thoughts')
      .update({ tags, category, summary, enriched_at: new Date().toISOString() })
      .eq('id', t.id).is('enriched_at', null)
    if (upErr) throw upErr

    return ok({ enriched: t.id, tags, category, summary })
  } catch (err) {
    console.error('[enrich] Failed:', err instanceof Error ? err.message : String(err))
    return ok({ error: 'enrichment failed — see logs' })
  }
})
