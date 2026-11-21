// ============================================================================
// COACH-CHAT — your AI coach, wired into the whole Command Center.
// ============================================================================
// Ask it anything about your system, or press "How do I improve my system?".
// Before answering, it reads:
//   • the full map: every section, agent, board member and what each can access
//   • the Board's latest verdicts
//   • what you've added to your brain recently, and notes related to the question
//   • your conversation so far (saved in cc_chat, so it remembers)
//
// When it recommends adding something to the map, it attaches a ready-made
// proposal the Command Center shows as an "Add to map" button.
//
// DEPLOY WITH:
//   npx supabase functions deploy coach-chat --no-verify-jwt
// ============================================================================

import { admin, corsHeaders, json, signedInUser } from '../_shared/http.ts'
import { askClaude, type Turn } from '../_shared/claude.ts'
import { searchBrain } from '../_shared/search.ts'
import { loadSystem, renderHits, renderSystem } from '../_shared/system-map.ts'

const HISTORY = 20
const MAX_MESSAGES_PER_HOUR = 60

const SUGGEST = 'Look over my whole system right now and tell me the 3-5 most valuable improvements I should make next. ' +
  'Consider gaps, risky access, agents that should exist but don\'t, and anything the Board flagged.'

const SYSTEM = `You are the owner's AI coach. You sit beside their "Open Brain" Command Center: a map with their brain in the center, the sections and AI agents connected to it, and a Board of Directors above it (a Scripture advisor, a finance advisor, a tester, and any others they add).

Your job:
- Answer questions about their system clearly and practically.
- Proactively suggest how to make the system better: missing agents, connections that are too broad (least access wins), automation they could add, things that are "planned" but stalled.
- Take the Board's verdicts seriously and help the owner act on them. Never overrule the Scripture advisor on moral questions; point the owner back to it.
- Be direct and encouraging. Short paragraphs and bullets. No filler.

When (and only when) you recommend adding something concrete to the map, end your reply with a fenced block exactly like this so the app can add it with one click:
\`\`\`proposal
[{"kind":"agent","name":"...","emoji":"🤖","description":"...","runs_on":"...","parent":"name of an existing section or empty","connections":[{"system":"...","access":"read"}]}]
\`\`\`
kind is "agent", "section" or "board". access is "read", "write", "read/write" or "admin".`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405)

  try {
    const user = await signedInUser(req)
    if (!user) return json({ ok: false, error: 'Not signed in' }, 401)

    const body = await req.json().catch(() => ({}))
    const message = (body.suggest ? SUGGEST : String(body.message ?? '')).trim().slice(0, 8000)
    if (!message) return json({ ok: false, error: 'Ask the coach something.' }, 400)

    const { count } = await admin.from('cc_chat').select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).eq('role', 'user').gte('created_at', new Date(Date.now() - 3600_000).toISOString())
    if ((count ?? 0) >= MAX_MESSAGES_PER_HOUR) return json({ ok: false, error: 'Slow down a little — try again in a few minutes.' }, 429)

    const [{ nodes, conns }, history, reviews, recent, hits] = await Promise.all([
      loadSystem(admin, user.id),
      admin.from('cc_chat').select('role, content').eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(HISTORY).then((r: { data: Turn[] | null }) => (r.data ?? []).reverse()),
      admin.from('cc_reviews').select('subject, verdict, score, summary, created_at, cc_nodes!cc_reviews_member_id_fkey(name)')
        .eq('user_id', user.id).order('created_at', { ascending: false }).limit(10).then((r: { data: unknown[] | null }) => r.data ?? []),
      admin.from('thoughts').select('content, summary, created_at').eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(15).then((r: { data: unknown[] | null }) => r.data ?? []),
      searchBrain(admin, user.id, message.slice(0, 500), 6).catch(() => []),
    ])

    // deno-lint-ignore no-explicit-any
    const reviewText = (reviews as any[]).map(r =>
      `- ${r.created_at.slice(0, 10)} ${r.cc_nodes?.name ?? 'Board'}: ${r.verdict} ${r.score}/10 on "${String(r.subject).slice(0, 80)}" — ${r.summary}`,
    ).join('\n') || '(no reviews yet)'

    const context = `[Live context — not written by the owner]
SYSTEM MAP:
${renderSystem(nodes, conns)}

LATEST BOARD VERDICTS:
${reviewText}

RECENTLY ADDED TO THE BRAIN:
${renderHits(recent as never[])}

NOTES RELATED TO THIS QUESTION:
${renderHits(hits)}
[End of context]

${message}`

    // Make sure the conversation alternates and starts with the owner.
    const turns: Turn[] = []
    for (const t of history) {
      if (!turns.length && t.role !== 'user') continue
      if (turns.length && turns[turns.length - 1].role === t.role) turns[turns.length - 1].content += '\n\n' + t.content
      else turns.push({ role: t.role, content: t.content })
    }
    if (turns.length && turns[turns.length - 1].role === 'user') turns.pop()
    turns.push({ role: 'user', content: context })

    const reply = await askClaude({
      system: SYSTEM, messages: turns, effort: 'medium', maxTokens: 8000,
      userId: user.id, source: 'coach',
    })

    // Explicit times so the question always sorts before its answer.
    const now = Date.now()
    const { error } = await admin.from('cc_chat').insert([
      { user_id: user.id, role: 'user', content: body.suggest ? '💡 How do I improve my system?' : message,
        created_at: new Date(now - 1).toISOString() },
      { user_id: user.id, role: 'assistant', content: reply, created_at: new Date(now).toISOString() },
    ])
    if (error) console.warn('[coach] chat not saved:', error.message)

    return json({ ok: true, reply })
  } catch (err) {
    console.error('[coach] Failed:', err instanceof Error ? err.message : String(err))
    return json({ ok: false, error: 'The coach is unavailable right now. Try again in a moment.' }, 500)
  }
})
