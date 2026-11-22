// ============================================================================
// COACH-CHAT — your AI coach, watching your AI life home page.
// ============================================================================
// Its main job: find mistakes, gaps and stale spots on your Command Center
// map and ASK YOU about them, one clear question at a time. Your answers turn
// into one-click fixes ("Apply to map").
//
//   { audit: true }        → check the whole home page, return questions
//   { message: "..." }     → normal chat, or your answer to one of its questions
//
// Before answering it reads:
//   • the full map: every section, agent, board member and what each can access
//   • a list of problems this code finds on its own (below), so the coach
//     works from facts, not guesses
//   • the Board's latest verdicts, what you've saved recently, related notes
//   • your conversation so far (saved in cc_chat, so it remembers)
//
// DEPLOY WITH:
//   npx supabase functions deploy coach-chat --no-verify-jwt
// ============================================================================

import { admin, corsHeaders, json, signedInUser } from '../_shared/http.ts'
import { askClaude, type Turn } from '../_shared/claude.ts'
import { searchBrain } from '../_shared/search.ts'
import { type Connection, loadSystem, type Node, renderHits, renderSystem } from '../_shared/system-map.ts'

const HISTORY = 20
const MAX_MESSAGES_PER_HOUR = 60
const DAY = 86400_000

const AUDIT = 'Check my AI life home page for mistakes, gaps and things that are out of date, and ask me about the most important ones.'

const SYSTEM = `You are the owner's AI coach. You watch over their "AI life home page": a Command Center map with their brain in the center, the sections of their life and business around it, the AI agents inside those sections (with every system each one can access), and a Board of Directors above it.

YOUR MAIN JOB is to keep that home page accurate, complete and safe by finding problems and ASKING THE OWNER about them. Think like a sharp chief of staff doing a walkthrough:
- Facts that are missing or vague (no description, unknown access, "runs on" blank)
- Things that look wrong or contradictory (an agent with write access it doesn't need, a section marked active with nothing in it, a name that doesn't match what it does)
- Things that are stale (planned for weeks, building with no progress, a Board warning nobody acted on)
- Things the owner said elsewhere in their brain that the map doesn't reflect yet

Ask, don't lecture. Each question must be specific to ONE item on the map, answerable in a sentence, and make it obvious why it matters. Never ask something the map or notes already answer. Do NOT pitch new board members or new agents unless the owner asks for ideas.

FORMATS — the app turns these fenced blocks into interactive cards, so follow them exactly:

1) To ask questions (at most 5, most important first), end your reply with:
\`\`\`questions
[{"node":"exact name on the map, or Home page","issue":"what you noticed, under 15 words","question":"your question","options":["optional quick answer","another"]}]
\`\`\`
"options" is optional: include 2-4 short quick answers only when the likely answers are obvious.

2) When the owner's answer means the map should change, propose the exact change and end your reply with:
\`\`\`update
[{"node":"exact name on the map","description":"...","status":"active|building|planned|paused","runs_on":"...","instructions":"...","add_connections":[{"system":"...","access":"read|write|read/write|admin","detail":"..."}],"remove_connections":["system name"],"set_access":[{"system":"...","access":"read"}]}]
\`\`\`
Include only the fields that change. After an update, ask the next most important question (another questions block) if any remain.

3) Only if the owner asks for new agents or seats, you may use:
\`\`\`proposal
[{"kind":"agent|section|board","name":"...","emoji":"🤖","description":"...","runs_on":"...","parent":"section name or empty","connections":[{"system":"...","access":"read"}]}]
\`\`\`

Keep the text before any block short: one or two sentences. Be direct and warm. Take the Board's verdicts seriously, and on moral questions point the owner to the Scripture seat rather than ruling yourself.`

type NodeRow = Node & { created_at: string; updated_at: string }
type Review = { node_id: string | null; member_id: string | null; verdict: string | null; score: number | null; summary: string; created_at: string }

// ---------------------------------------------------------------------------
// The walkthrough: plain code that spots problems on the map. Facts only —
// the coach decides which matter most and how to ask.
// ---------------------------------------------------------------------------
function findIssues(nodes: NodeRow[], conns: Connection[], reviews: Review[], icloudCount: number): string[] {
  const issues: string[] = []
  const now = Date.now()
  const days = (iso: string) => Math.floor((now - new Date(iso).getTime()) / DAY)
  const nameOf = (id: string | null) => nodes.find(n => n.id === id)?.name ?? 'the Board'
  const seen = new Map<string, number>()

  for (const n of nodes) {
    const key = n.name.trim().toLowerCase()
    seen.set(key, (seen.get(key) ?? 0) + 1)
    const mine = conns.filter(c => c.node_id === n.id)
    const label = `"${n.name}" (${n.kind}, ${n.status})`

    if (n.kind === 'board') {
      if (!n.instructions.trim()) issues.push(`${label}: has no instructions for how to judge.`)
      continue
    }
    if (!n.description.trim()) issues.push(`${label}: no description of what it does.`)
    if (!mine.length) issues.push(`${label}: no connected systems recorded, so it's unclear what it can access.`)
    if (n.kind === 'agent' && !n.runs_on.trim()) issues.push(`${label}: "runs on" is blank (where does it actually run?).`)
    if (n.kind === 'agent' && !n.instructions.trim()) issues.push(`${label}: no instructions saved for the agent.`)
    for (const c of mine) {
      if (c.access === 'admin' || (n.kind === 'agent' && /write/.test(c.access))) {
        issues.push(`${label}: has ${c.access} access to ${c.system}${c.detail ? ` (${c.detail})` : ''}. Is that needed?`)
      }
    }
    if (n.status === 'planned' && days(n.created_at) >= 7) issues.push(`${label}: planned for ${days(n.created_at)} days with no change of status.`)
    if (n.status === 'building' && days(n.updated_at) >= 14) issues.push(`${label}: marked building but untouched for ${days(n.updated_at)} days.`)
    if (n.kind === 'section' && n.status !== 'planned' && !nodes.some(a => a.parent_id === n.id)) {
      issues.push(`${label}: no agents inside it yet. Who or what does the work?`)
    }
    if (n.kind === 'agent' && n.status === 'active' && n.parent_id && nodes.find(s => s.id === n.parent_id)?.status === 'planned') {
      issues.push(`${label}: active, but its section "${nameOf(n.parent_id)}" is still marked planned.`)
    }
    // The newest verdict on this item, if it was a warning made after the last edit
    const latest = reviews.filter(r => r.node_id === n.id && r.verdict)
    const warn = latest.find(r => r.verdict === 'conflict' || r.verdict === 'caution')
    if (warn && new Date(warn.created_at) > new Date(n.updated_at)) {
      issues.push(`${label}: ${nameOf(warn.member_id)} gave "${warn.verdict}" ${warn.score}/10 ${days(warn.created_at)}d ago and it hasn't changed since: "${warn.summary.slice(0, 160)}"`)
    }
    if (!latest.length && n.status !== 'planned') issues.push(`${label}: the Board has never reviewed it.`)
  }
  for (const [name, count] of seen) if (count > 1) issues.push(`"${name}" appears ${count} times on the map.`)

  const sync = nodes.find(n => /icloud/i.test(n.name))
  if (sync && icloudCount === 0) issues.push(`"${sync.name}": nothing from iCloud has reached the brain yet. The Mac sync is probably not installed or not running.`)
  if (sync && icloudCount > 0 && sync.status === 'planned') issues.push(`"${sync.name}": iCloud items are arriving, but the map still says planned.`)
  if (!nodes.some(n => n.kind === 'board')) issues.push('Home page: there is no Board of Directors.')

  return issues
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405)

  try {
    const user = await signedInUser(req)
    if (!user) return json({ ok: false, error: 'Not signed in' }, 401)

    const body = await req.json().catch(() => ({}))
    const audit = !!(body.audit || body.suggest)
    const message = (audit ? AUDIT : String(body.message ?? '')).trim().slice(0, 8000)
    if (!message) return json({ ok: false, error: 'Ask the coach something.' }, 400)

    const { count } = await admin.from('cc_chat').select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).eq('role', 'user').gte('created_at', new Date(Date.now() - 3600_000).toISOString())
    if ((count ?? 0) >= MAX_MESSAGES_PER_HOUR) return json({ ok: false, error: 'Slow down a little — try again in a few minutes.' }, 429)

    const [{ nodes, conns }, rows, history, reviews, recent, hits, icloud] = await Promise.all([
      loadSystem(admin, user.id),
      admin.from('cc_nodes').select('id, created_at, updated_at').eq('user_id', user.id)
        .then((r: { data: { id: string; created_at: string; updated_at: string }[] | null }) => r.data ?? []),
      admin.from('cc_chat').select('role, content').eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(HISTORY).then((r: { data: Turn[] | null }) => (r.data ?? []).reverse()),
      admin.from('cc_reviews').select('node_id, member_id, verdict, score, summary, subject, created_at')
        .eq('user_id', user.id).order('created_at', { ascending: false }).limit(60).then((r: { data: unknown[] | null }) => r.data ?? []),
      admin.from('thoughts').select('content, summary, created_at').eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(15).then((r: { data: unknown[] | null }) => r.data ?? []),
      searchBrain(admin, user.id, message.slice(0, 500), 6).catch(() => []),
      admin.from('thoughts').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
        .like('metadata->>source', 'icloud-%').then((r: { count: number | null }) => r.count ?? 0),
    ])

    const times = new Map(rows.map((r: { id: string; created_at: string; updated_at: string }) => [r.id, r]))
    const fullNodes = nodes.map(n => ({ ...n, ...(times.get(n.id) ?? { created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) })) as NodeRow[]
    const issues = findIssues(fullNodes, conns, reviews as Review[], icloud)

    // deno-lint-ignore no-explicit-any
    const reviewText = (reviews as any[]).filter(r => r.verdict).slice(0, 10).map(r =>
      `- ${r.created_at.slice(0, 10)} ${nodes.find(n => n.id === r.member_id)?.name ?? 'Board'}: ${r.verdict} ${r.score}/10 on "${String(r.subject).split('\n')[0].slice(0, 80)}" — ${r.summary}`,
    ).join('\n') || '(no reviews yet)'

    const context = `[Live context — not written by the owner]
HOME PAGE (the map) RIGHT NOW:
${renderSystem(nodes, conns)}

PROBLEMS FOUND ON THE HOME PAGE (checked by code, all true right now):
${issues.length ? issues.map(i => '- ' + i).join('\n') : '(none found automatically — look for subtler gaps)'}

LATEST BOARD VERDICTS:
${reviewText}

RECENTLY ADDED TO THE BRAIN:
${renderHits(recent as never[])}

NOTES RELATED TO THIS MESSAGE:
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
      userId: user.id, source: audit ? 'coach:audit' : 'coach',
    })

    // Explicit times so the question always sorts before its answer.
    const now = Date.now()
    const { error } = await admin.from('cc_chat').insert([
      { user_id: user.id, role: 'user', content: audit ? '🔍 Check my home page' : message,
        created_at: new Date(now - 1).toISOString() },
      { user_id: user.id, role: 'assistant', content: reply, created_at: new Date(now).toISOString() },
    ])
    if (error) console.warn('[coach] chat not saved:', error.message)

    return json({ ok: true, reply, issues: issues.length })
  } catch (err) {
    console.error('[coach] Failed:', err instanceof Error ? err.message : String(err))
    return json({ ok: false, error: 'The coach is unavailable right now. Try again in a moment.' }, 500)
  }
})
