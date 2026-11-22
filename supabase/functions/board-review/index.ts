// ============================================================================
// BOARD-REVIEW — your Board of Directors weighs in.
// ============================================================================
// Send it something to judge: a free-text idea, a node on your map (an agent
// or a section), or a thought from your brain. Every board member reviews it
// AT THE SAME TIME, each through their own lens (Scripture, finance, testing,
// or any member you add), and every verdict is saved to cc_reviews.
//
// Each member sees:
//   • their own instructions (edit them in the Command Center)
//   • the thing being judged
//   • the whole system map (what exists and what it can access)
//   • related notes from your brain
//   • code snapshots of any GitHub repos connected to that member (Tester)
//   • live web search, if "Web" is one of that member's connections (Finance)
//   • their LIBRARY: books on their shelf (connections named "Book") and your
//     own notes on those books — they judge by those books' principles
//
// Called by:   the Command Center ("Ask the Board")       — with your login
//              enrich-thought, for new ideas and plans      — with the service key
//
// DEPLOY WITH:
//   npx supabase functions deploy board-review --no-verify-jwt
// Optional secret for the Tester to read private repos:
//   npx supabase secrets set GITHUB_TOKEN=github_pat_...   (read-only token)
// ============================================================================

import { admin, corsHeaders, json, signedInUser } from '../_shared/http.ts'
import { askClaude } from '../_shared/claude.ts'
import { parseJsonObject } from '../_shared/llm.ts'
import { searchBrain } from '../_shared/search.ts'
import { type Connection, connectionsOf, loadSystem, type Node, renderHits, renderSystem } from '../_shared/system-map.ts'

const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN') ?? ''
const MAX_REVIEWS_PER_HOUR = 40

const BASE_PROMPT = `You sit on the Board of Directors of the owner's personal AI system. The board sits ABOVE the owner's "brain" (their knowledge base) and every agent and business connected to it. Your job is to give an honest, independent, third-party outlook — not to flatter, and not to rubber-stamp.

Speak to the owner directly ("you"). Be specific to what they actually wrote and built; cite the evidence you used. If something is genuinely good, say so plainly. If you lack the information to judge, say what you would need to know.

Reply with ONLY a JSON object, no other text:
{
  "verdict": one of "aligned", "caution", "conflict"   (how well this holds up under YOUR lens),
  "score": integer 1-10 (10 = fully sound under your lens),
  "summary": 1-3 sentence bottom line,
  "concerns": array of short strings (what worries you — may be empty),
  "suggestions": array of short, concrete next steps,
  "references": array of short strings (verses, data points, files or sources you relied on),
  "questions": array of sharp questions the owner should be asking but isn't
}`

// ---------------------------------------------------------------------------
// GitHub snapshot — what the Tester reads before judging your code.
// ---------------------------------------------------------------------------
function repoFrom(c: Connection): string | null {
  const text = `${c.url} ${c.detail}`
  const m = text.match(/github\.com\/([\w.-]+\/[\w.-]+)/i) ?? text.match(/\b([\w.-]+\/[\w.-]+)\b/)
  return m ? m[1].replace(/\.git$/, '') : null
}

async function gh(path: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'open-brain-board',
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`)
  return res.json()
}

async function repoSnapshot(repo: string): Promise<string> {
  try {
    const info = await gh(`/repos/${repo}`)
    const branch = info.default_branch
    const [tree, commits, readme] = await Promise.all([
      gh(`/repos/${repo}/git/trees/${branch}?recursive=1`).catch(() => ({ tree: [] })),
      gh(`/repos/${repo}/commits?per_page=8`).catch(() => []),
      gh(`/repos/${repo}/readme`).catch(() => null),
    ])
    const files = (tree.tree ?? []).filter((t: { type: string }) => t.type === 'blob')
      .map((t: { path: string }) => t.path).slice(0, 200)
    const readmeText = readme?.content ? atob(readme.content.replace(/\n/g, '')).slice(0, 5000) : '(no README)'
    const log = (commits as { commit: { message: string; author: { date: string } } }[])
      .map(c => `- ${c.commit.author.date.slice(0, 10)} ${c.commit.message.split('\n')[0]}`).join('\n')
    return `REPO ${repo} (default branch ${branch}, ${info.open_issues_count} open issues, last push ${info.pushed_at})
Files (${files.length} shown):
${files.join('\n')}

Recent commits:
${log || '(none)'}

README:
${readmeText}`
  } catch (err) {
    return `REPO ${repo}: could not read it (${err instanceof Error ? err.message : String(err)}). ` +
      `If it is private, set a read-only GITHUB_TOKEN secret.`
  }
}

// ---------------------------------------------------------------------------
// The member's library — books on their shelf (connections whose system is
// "Book"), plus anything the owner has saved in their brain about each book:
// highlights, summaries, notes. The member judges by those books' principles.
// ---------------------------------------------------------------------------
async function libraryFor(memberConns: Connection[], userId: string): Promise<string> {
  const books = memberConns.filter(c => /^book/i.test(c.system)).map(c => c.detail.trim()).filter(Boolean).slice(0, 12)
  if (!books.length) return ''
  const notes = await Promise.all(books.map(b =>
    searchBrain(admin, userId, b.split(/[—–-]/)[0].trim().slice(0, 200), 3).catch(() => [])))
  const shelf = books.map((b, i) => {
    const mine = notes[i].length ? `\n  The owner's own notes on it:\n${renderHits(notes[i]).replace(/^/gm, '    ')}` : ''
    return `- ${b}${mine}`
  }).join('\n')
  return `\n---\nYOUR LIBRARY — the books the owner values and wants decisions judged by:
${shelf}

Ground your review in the core principles of these books. Name the book and the specific idea you are applying
(e.g. "Rich Dad Poor Dad: assets put money in your pocket, liabilities take it out"; "Atomic Habits: make it easy —
reduce friction"). Paraphrase in your own words; do not quote more than a short phrase, and never invent quotes or
page numbers. Where two books pull in different directions, say so. The owner's own notes on a book outrank your
general knowledge of it. List the books and ideas you used in "references".`
}

// ---------------------------------------------------------------------------
// One member's review
// ---------------------------------------------------------------------------
async function reviewAs(
  member: Node, memberConns: Connection[], subject: string, systemText: string, brainText: string, userId: string,
) {
  const repos = memberConns.filter(c => /github/i.test(c.system)).map(repoFrom).filter(Boolean) as string[]
  const snapshots = repos.length ? await Promise.all(repos.slice(0, 3).map(repoSnapshot)) : []
  const canSearch = memberConns.some(c => /^web|internet|market/i.test(c.system))
  const library = await libraryFor(memberConns, userId)

  const prompt = [
    `THE OWNER WANTS YOUR REVIEW OF:\n${subject}`,
    `\n---\nTHE OWNER'S SYSTEM RIGHT NOW:\n${systemText}`,
    `\n---\nRELATED NOTES FROM THE OWNER'S BRAIN:\n${brainText}`,
    snapshots.length ? `\n---\nCODE YOU HAVE ACCESS TO:\n${snapshots.join('\n\n')}` : '',
    library,
    canSearch ? '\n---\nYou may search the web for current facts (prices, markets, news). Cite what you find.' : '',
  ].join('\n')

  const text = await askClaude({
    system: `${BASE_PROMPT}\n\nYOUR SEAT ON THE BOARD: ${member.emoji} ${member.name}\n${member.instructions || member.description}`,
    messages: [{ role: 'user', content: prompt }],
    effort: 'high',
    webSearch: canSearch ? 3 : 0,
    userId,
    source: `board:${member.name}`,
  })
  const out = parseJsonObject(text)
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 8) : [])
  return {
    verdict: ['aligned', 'caution', 'conflict'].includes(String(out.verdict)) ? String(out.verdict) : 'caution',
    score: Math.min(10, Math.max(1, Math.round(Number(out.score) || 5))),
    summary: String(out.summary ?? '').slice(0, 1200),
    feedback: {
      concerns: list(out.concerns), suggestions: list(out.suggestions),
      references: list(out.references), questions: list(out.questions),
    },
  }
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405)

  try {
    const body = await req.json().catch(() => ({}))

    // Who is this for? Your login — or, from our own functions, the service key.
    let userId: string | null = null
    const internal = (req.headers.get('Authorization') ?? '') === `Bearer ${SERVICE_ROLE_KEY}`
    if (internal) userId = typeof body.user_id === 'string' ? body.user_id : null
    else userId = (await signedInUser(req))?.id ?? null
    if (!userId) return json({ ok: false, error: 'Not signed in' }, 401)

    // Bill guard
    const { count } = await admin.from('cc_reviews').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).gte('created_at', new Date(Date.now() - 3600_000).toISOString())
    if ((count ?? 0) >= MAX_REVIEWS_PER_HOUR) {
      return json({ ok: false, error: 'The Board has reviewed a lot this hour. Try again later.' }, 429)
    }

    const { nodes, conns } = await loadSystem(admin, userId)
    const board = nodes.filter(n => n.kind === 'board')
    const wanted: string[] = Array.isArray(body.member_ids) ? body.member_ids.map(String) : []
    const members = wanted.length ? board.filter(m => wanted.includes(m.id)) : board
    if (!members.length) return json({ ok: false, error: 'Your Board has no members yet.' }, 400)

    // What is being judged?
    let subject = String(body.subject ?? '').trim().slice(0, 20_000)
    let nodeId: string | null = null, thoughtId: string | null = null
    if (body.node_id) {
      const n = nodes.find(x => x.id === body.node_id)
      if (!n) return json({ ok: false, error: 'That item is not on your map.' }, 404)
      nodeId = n.id
      const access = connectionsOf(conns, n.id).map(c => `${c.system} (${c.access}${c.detail ? `: ${c.detail}` : ''})`)
      subject = `${subject ? subject + '\n\n' : ''}The ${n.kind} "${n.name}" (${n.status}${n.runs_on ? `, runs on ${n.runs_on}` : ''}).\n` +
        `Purpose: ${n.description || '(not described)'}\nInstructions: ${n.instructions || '(none)'}\n` +
        `Access: ${access.join('; ') || 'none recorded'}`
    } else if (body.thought_id) {
      const { data: t } = await admin.from('thoughts').select('id, content')
        .eq('id', body.thought_id).eq('user_id', userId).maybeSingle()
      if (!t) return json({ ok: false, error: 'Thought not found.' }, 404)
      thoughtId = t.id
      subject = `A note the owner just saved:\n${String(t.content).slice(0, 20_000)}`
    }
    if (!subject) return json({ ok: false, error: 'Give the Board something to review.' }, 400)

    const hits = await searchBrain(admin, userId, subject.slice(0, 500), 8).catch(() => [])
    const systemText = renderSystem(nodes, conns)
    const brainText = renderHits(hits)

    const results = await Promise.allSettled(members.map(m =>
      reviewAs(m, connectionsOf(conns, m.id), subject, systemText, brainText, userId!)))

    const rows = results.flatMap((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[board] ${members[i].name} failed:`, r.reason instanceof Error ? r.reason.message : String(r.reason))
        return []
      }
      return [{ user_id: userId, member_id: members[i].id, node_id: nodeId, thought_id: thoughtId,
        subject: subject.slice(0, 2000), ...r.value }]
    })
    if (!rows.length) return json({ ok: false, error: 'The Board could not reach a verdict. Try again in a moment.' }, 502)

    const { data: saved, error } = await admin.from('cc_reviews').insert(rows).select()
    if (error) throw error
    return json({ ok: true, reviews: saved, failed: members.length - rows.length })
  } catch (err) {
    console.error('[board] Failed:', err instanceof Error ? err.message : String(err))
    return json({ ok: false, error: 'The Board review failed. Try again in a moment.' }, 500)
  }
})
