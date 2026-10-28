// ============================================================================
// ENRICH-THOUGHT — tags, meaning, and links for every new thought.
// ============================================================================
// Runs automatically every time a new thought is saved (a database trigger
// calls it — see level5.sql). Three jobs, each skipped if already done:
//   1. TAG   — ask the AI (through the LLM gateway) for 3–5 tags, a category
//              and a one-sentence summary                       (Level 5)
//   2. MAP   — turn the thought into its meaning coordinates (an embedding)
//                                                                (Level 6)
//   3. LINK  — connect it to the existing thoughts that mean something
//              similar, in the thought_links table               (Level 6)
//
// DEPLOY WITH:
//   npx supabase functions deploy enrich-thought --no-verify-jwt
//
// Why no login check: the caller only ever sends a thought's id. This code
// loads the thought itself and only does work that hasn't been done yet.
// Thought ids are random and unguessable, so a stranger calling this can't
// read anything, change anything you wrote, or run up your bill.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLM, parseJsonObject } from '../_shared/llm.ts'
import { embed, embeddingText, toPgVector } from '../_shared/embed.ts'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection']
const MAX_CHARS_TO_AI = 12_000   // a long transcript only needs its opening to be tagged well
// How alike two thoughts must be to get linked (0–1). Tuned for gte-small,
// which scores even unrelated English text fairly high.
const LINK_THRESHOLD = Number(Deno.env.get('LINK_THRESHOLD') ?? '0.82')
const LINKS_PER_THOUGHT = 5

const SYSTEM = 'You organize notes in a personal knowledge base. Reply with JSON only.'

function ok(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

type Thought = {
  id: string; content: string; user_id: string | null; category: string | null
  tags: string[] | null; summary: string | null; enriched_at: string | null; embedding: unknown
}

async function tag(t: Thought): Promise<Partial<Thought>> {
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

  const { error } = await db.from('thoughts')
    .update({ tags, category, summary, enriched_at: new Date().toISOString() })
    .eq('id', t.id).is('enriched_at', null)
  if (error) throw error
  return { tags, category, summary }
}

async function mapAndLink(t: Thought): Promise<{ embedded: boolean; links: number }> {
  const vector = await embed(embeddingText(t))
  if (!vector) return { embedded: false, links: 0 }   // can be filled in later

  const pg = toPgVector(vector)
  const { error } = await db.from('thoughts').update({ embedding: pg }).eq('id', t.id)
  if (error) throw error

  // Digests summarize everything, so they'd link to everything — leave them out.
  if (!t.user_id || t.category === 'digest') return { embedded: true, links: 0 }

  const { data: neighbors, error: nErr } = await db.rpc('find_links_for_thought', {
    source_id: t.id,
    source_embedding: pg,
    p_user_id: t.user_id,
    match_threshold: LINK_THRESHOLD,
    match_count: LINKS_PER_THOUGHT,
  })
  if (nErr) throw nErr
  if (!neighbors || !neighbors.length) return { embedded: true, links: 0 }

  // One at a time: the "A→B blocks B→A" rule would make a batch fail as a whole.
  let links = 0
  for (const n of neighbors as { target_id: string; similarity: number }[]) {
    const { error: lErr } = await db.from('thought_links').insert({
      source_thought_id: t.id,
      target_thought_id: n.target_id,
      user_id: t.user_id,
      similarity_score: n.similarity,
      link_type: 'semantic',
    })
    if (!lErr) links++
    else if (lErr.code !== '23505') console.warn('[enrich] link not saved:', lErr.message)   // 23505 = already linked
  }
  return { embedded: true, links }
}

Deno.serve(async (req) => {
  // Always answer 200 — a failed enrichment must never look like a failed save.
  try {
    const body = await req.json().catch(() => ({}))
    // Accepts { id } from our trigger, or a Supabase webhook's { record: { id } }
    const id = String(body?.id ?? body?.record?.id ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(id)) return ok({ skipped: 'no thought id' })

    const { data, error } = await db.from('thoughts')
      .select('id, content, user_id, category, tags, summary, enriched_at, embedding')
      .eq('id', id).maybeSingle()
    if (error) throw error
    if (!data) return ok({ skipped: 'not found' })
    let t = data as Thought
    if ((t.content ?? '').trim().length < 20) return ok({ skipped: 'too short' })

    const result: Record<string, unknown> = { id: t.id }

    if (!t.enriched_at && t.category !== 'digest') {
      try {
        t = { ...t, ...(await tag(t)) }
        result.tagged = true
      } catch (err) {
        // Keep going: meaning and links don't depend on the tags.
        console.error('[enrich] Tagging failed:', err instanceof Error ? err.message : String(err))
      }
    }

    if (!t.embedding) Object.assign(result, await mapAndLink(t))

    return ok(result)
  } catch (err) {
    console.error('[enrich] Failed:', err instanceof Error ? err.message : String(err))
    return ok({ error: 'enrichment failed — see logs' })
  }
})
