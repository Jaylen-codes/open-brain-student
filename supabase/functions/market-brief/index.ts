// ============================================================================
// MARKET-BRIEF — your Finance board member's morning report.
// ============================================================================
// A schedule in the database (command-center.sql) calls this every weekday
// morning. It:
//   1. searches the web for what markets did and what's moving today
//   2. reads your ArbCity section and your financial goals from your brain
//   3. writes a brief: markets → what it means for YOU → today's moves
//   4. saves it as a thought (category 'market-brief') and as a Board review
//      so it shows on the Finance seat in the Command Center
//   5. sends it to your Telegram, if you set that up in Level 3
//
// Press "Run brief now" in the Command Center to get one on demand.
//
// DEPLOY WITH:
//   npx supabase functions deploy market-brief --no-verify-jwt
//
// Why no login check for the schedule: a schedule can't log in. Instead it
// guards your bill — at most one brief every 18 hours, unless YOU (signed in)
// ask for one.
// ============================================================================

import { admin, corsHeaders, json, signedInUser } from '../_shared/http.ts'
import { askClaude } from '../_shared/claude.ts'
import { searchBrain } from '../_shared/search.ts'
import { connectionsOf, loadSystem, renderHits } from '../_shared/system-map.ts'

const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''
const HOUR = 3600_000

const DEFAULT_SEAT = 'You are a professional financial advisor (CFA-level) who tracks daily markets. ' +
  'You are conservative about risk and blunt about it. You are not a licensed advisor to the owner; say so only if they ask for a specific trade.'

async function sendTelegram(text: string) {
  if (!BOT_TOKEN || !CHAT_ID) return
  for (let i = 0; i < text.length; i += 4000) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: text.slice(i, i + 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    }).catch(err => console.warn('[brief] Telegram send failed:', String(err)))
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  try {
    // Signed in = on demand. Otherwise = the schedule, for the owner only.
    const user = await signedInUser(req)
    const userId = user?.id ?? OWNER_USER_ID
    if (!userId) return json({ ok: false, skipped: 'OWNER_USER_ID is not set' })

    // Bill guard: schedule → one per 18 hours; on demand → one per hour.
    const gap = user ? 1 : 18
    const { data: recent } = await admin.from('thoughts').select('id')
      .eq('user_id', userId).eq('category', 'market-brief')
      .gte('created_at', new Date(Date.now() - gap * HOUR).toISOString()).limit(1)
    if (recent?.length) {
      return json({ ok: !user, skipped: true, error: `A brief was already written in the last ${gap} hour${gap > 1 ? 's' : ''}.` })
    }

    const { nodes, conns } = await loadSystem(admin, userId)
    const finance = nodes.find(n => n.kind === 'board' && /financ|money|market|cfo/i.test(n.name))
    const arb = nodes.filter(n => /arb/i.test(n.name))
    const arbText = arb.map(n => `${n.name}: ${n.description}\nAccess: ` +
      connectionsOf(conns, n.id).map(c => `${c.system} (${c.detail || c.access})`).join('; ')).join('\n') || '(no ArbCity section on the map yet)'

    const [goals, arbNotes] = await Promise.all([
      searchBrain(admin, userId, 'my financial goals budget savings investing plan', 6).catch(() => []),
      searchBrain(admin, userId, 'ArbCity betting bankroll ROI profit exposure', 6).catch(() => []),
    ])

    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Denver' })

    const brief = await askClaude({
      system: `${finance?.instructions || DEFAULT_SEAT}\n\nYou are writing the owner's morning market brief for ${today}. ` +
        'Use web search to get TODAY\'s real numbers — never invent figures. Plain text for a phone screen (Telegram), no markdown tables.',
      messages: [{
        role: 'user',
        content: `Write my brief in this shape:

MARKETS (5-7 bullets): S&P 500, Nasdaq, Dow futures/close, 10-year Treasury yield, Bitcoin, oil, the dollar — with numbers and % moves — plus the 1-2 headlines actually moving things and any data or Fed events on today's calendar.

WHAT IT MEANS FOR ME (3-5 bullets): connect today's markets to my goals and my ArbCity sports-arbitrage business below. Flag risk: bankroll concentration, sportsbook limits/counterparty risk, cash sitting idle, tax set-asides.

TODAY'S MOVES (1-3 bullets): concrete, conservative actions or things to watch.

MY ARBCITY SECTION:
${arbText}

MY ARBCITY NOTES:
${renderHits(arbNotes)}

MY FINANCIAL GOALS (from my notes):
${renderHits(goals)}`,
      }],
      effort: 'medium',
      maxTokens: 6000,
      webSearch: 6,
      userId,
      source: 'market-brief',
    })

    const content = `📈 Market brief — ${today}\n\n${brief}`
    // enriched_at set → the tagging agent leaves the category alone, but the
    // brief still gets mapped for search.
    const { data: thought, error } = await admin.from('thoughts').insert({
      user_id: userId, content, category: 'market-brief', tags: ['finance', 'markets', 'brief'],
      summary: `Market brief for ${today}`, enriched_at: new Date().toISOString(),
      metadata: { source: 'market-brief' },
    }).select('id').single()
    if (error) throw error

    if (finance) {
      await admin.from('cc_reviews').insert({
        user_id: userId, member_id: finance.id, thought_id: thought.id,
        subject: `Daily market brief — ${today}`, verdict: null, score: null,
        summary: brief.slice(0, 1200), feedback: { brief },
      })
    }
    await sendTelegram(content)
    return json({ ok: true, id: thought.id, brief })
  } catch (err) {
    console.error('[brief] Failed:', err instanceof Error ? err.message : String(err))
    return json({ ok: false, error: 'The market brief failed — see logs.' }, 500)
  }
})
