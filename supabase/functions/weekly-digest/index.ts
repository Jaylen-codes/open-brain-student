// ============================================================================
// WEEKLY-DIGEST — a report on your own mind, every Sunday morning.
// ============================================================================
// A schedule in the database (pg_cron — see the Level 5 SQL) calls this once
// a week. It reads your last 7 days of thoughts, asks the AI (through the LLM
// gateway) what you've been learning, saves the report as a new thought with
// category 'digest', and sends it to you on Telegram.
//
// DEPLOY WITH:
//   npx supabase functions deploy weekly-digest --no-verify-jwt
//
// Why no login check: a schedule can't log in. Instead it guards your bill —
// it refuses to write more than one digest every 6 days, so calling it over
// and over does nothing.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLM } from '../_shared/llm.ts'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

const DAY = 24 * 60 * 60 * 1000
const MIN_THOUGHTS = 5

function reply(body: Record<string, unknown>) {
  console.log('[digest]', JSON.stringify(body))
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function sendTelegram(text: string) {
  if (!BOT_TOKEN || !CHAT_ID) return
  // Telegram messages max out at 4096 characters — send in pieces if needed.
  for (let i = 0; i < text.length; i += 4000) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text: text.slice(i, i + 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (err) {
      console.warn('[digest] Telegram send failed:', String(err))
    }
  }
}

Deno.serve(async () => {
  try {
    if (!OWNER_USER_ID) return reply({ skipped: 'OWNER_USER_ID is not set' })
    const now = Date.now()

    // Bill guard: at most one digest every 6 days.
    const { data: recent, error: rErr } = await db.from('thoughts')
      .select('id').eq('user_id', OWNER_USER_ID).eq('category', 'digest')
      .gte('created_at', new Date(now - 6 * DAY).toISOString()).limit(1)
    if (rErr) throw rErr
    if (recent && recent.length) return reply({ skipped: 'a digest was already written in the last 6 days' })

    const { data: week, error } = await db.from('thoughts')
      .select('content, created_at, category, tags, summary')
      .eq('user_id', OWNER_USER_ID)
      .or('category.is.null,category.neq.digest')
      .gte('created_at', new Date(now - 7 * DAY).toISOString())
      .order('created_at', { ascending: true })
      .limit(200)
    if (error) throw error
    if (!week || week.length < MIN_THOUGHTS) {
      return reply({ skipped: `only ${week?.length ?? 0} thoughts this week — need at least ${MIN_THOUGHTS}` })
    }

    // Group by category, and keep each thought short so the prompt stays small.
    const groups: Record<string, string[]> = {}
    for (const t of week) {
      const cat = t.category ?? 'uncategorized'
      const when = new Date(t.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      const tags = Array.isArray(t.tags) && t.tags.length ? ` [${t.tags.join(', ')}]` : ''
      const gist = t.summary || t.content.replace(/\s+/g, ' ').slice(0, 500)
      ;(groups[cat] ??= []).push(`- (${when})${tags} ${gist}`)
    }
    const notes = Object.entries(groups).map(([cat, lines]) => `## ${cat}\n${lines.join('\n')}`).join('\n\n')

    const { text } = await callLLM({
      systemPrompt:
        'You write a warm, concise weekly review of a person\'s own notes, addressed to them as "you". ' +
        'Plain text only, no markdown symbols like # or **.',
      prompt:
        `Here is everything I saved in my personal knowledge base this week (${week.length} notes), grouped by category:\n\n` +
        notes +
        '\n\nWrite my weekly digest with three short sections:\n' +
        '1. What you were learning: the main things, in a few sentences each.\n' +
        '2. Key themes: 2 to 4 threads that connect several notes.\n' +
        '3. A question you seem to be exploring: one open question, and one small next step.\n' +
        'Keep it under 350 words.',
      maxTokens: 6000,
      userId: OWNER_USER_ID,
      source: 'weekly-digest',
    })

    const weekOf = new Date(now - 7 * DAY).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    const content = `📰 Weekly digest — week of ${weekOf}\n\n${text}`

    const { error: insErr } = await db.from('thoughts').insert({
      user_id: OWNER_USER_ID,
      content,
      category: 'digest',
      tags: ['digest'],
      summary: `Weekly digest for the week of ${weekOf}`,
      enriched_at: new Date().toISOString(),
      metadata: { source: 'weekly-digest', notes_read: week.length },
    })
    if (insErr) throw insErr

    await sendTelegram(content)
    return reply({ ok: true, notes_read: week.length })
  } catch (err) {
    console.error('[digest] Failed:', err instanceof Error ? err.message : String(err))
    return reply({ error: 'digest failed — see logs' })
  }
})
