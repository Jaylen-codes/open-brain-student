// ============================================================================
// CLAUDE — the "thinking" calls for the Command Center: Board, Coach, Brief.
// ============================================================================
// llm.ts is the cheap, quick gateway for routine jobs (tagging, digests).
// This one is for judgement: multi-turn conversation, optional web search,
// and deeper thinking. It always talks to Claude directly.
//
// Secrets it reads:
//   ANTHROPIC_API_KEY   (you already set this in Level 5)
//   BOARD_MODEL         optional — defaults to claude-opus-5-5
//
// If Claude's safety filters decline a request, the API automatically retries
// it on a fallback model (the `fallbacks` setting below), so a review never
// just silently fails.
//
// Every call writes a receipt to llm_usage, so `select * from my_spend();`
// shows what your Board and Coach cost.
// ============================================================================

import Anthropic from 'npm:@anthropic-ai/sdk'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const BOARD_MODEL = (Deno.env.get('BOARD_MODEL') ?? 'claude-opus-5-5').trim()

const PRICES: Record<string, [number, number]> = {
  'claude-opus-5-5': [4.00, 20.00],
  'claude-sonnet-5-5': [2.00, 10.00],
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-fable-5-2': [8.00, 40.00],
}

export type Turn = { role: 'user' | 'assistant'; content: string }

export interface ClaudeRequest {
  system: string
  messages: Turn[]
  effort?: 'low' | 'medium' | 'high' | 'xhigh'
  maxTokens?: number
  webSearch?: number          // > 0 lets Claude search the web, up to N times
  userId?: string
  source?: string             // which agent spent it, for the receipt
}

function receipt(userId: string | undefined, source: string | undefined, inTok: number, outTok: number) {
  if (!userId) return
  try {
    const [pin, pout] = PRICES[BOARD_MODEL] ?? [0, 0]
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    admin.from('llm_usage').insert({
      user_id: userId, kind: 'chat', model: BOARD_MODEL, source: source ?? null,
      prompt_tokens: inTok, completion_tokens: outTok,
      cost_usd: (inTok * pin + outTok * pout) / 1_000_000,
    }).then(({ error }) => { if (error) console.warn('[claude] receipt not saved:', error.message) },
            (err: unknown) => console.warn('[claude] receipt not saved:', String(err)))
  } catch (err) {
    console.warn('[claude] receipt not saved:', String(err))
  }
}

export async function askClaude(req: ClaudeRequest): Promise<string> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in Supabase secrets.')
  const client = new Anthropic({ apiKey })

  const tools = req.webSearch
    ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: req.webSearch }]
    : undefined

  // deno-lint-ignore no-explicit-any
  const messages: any[] = req.messages.map(m => ({ role: m.role, content: m.content }))
  let inTok = 0, outTok = 0
  // deno-lint-ignore no-explicit-any
  let response: any

  // A long web-search turn can pause; send it back and the server resumes.
  for (let round = 0; round < 4; round++) {
    response = await client.beta.messages.create({
      model: BOARD_MODEL,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      thinking: { type: 'adaptive' },
      output_config: { effort: req.effort ?? 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      ...(tools ? { tools } : {}),
      messages,
    // deno-lint-ignore no-explicit-any
    } as any)
    inTok += response.usage?.input_tokens ?? 0
    outTok += response.usage?.output_tokens ?? 0
    if (response.stop_reason !== 'pause_turn') break
    messages.push({ role: 'assistant', content: response.content })
  }

  receipt(req.userId, req.source, inTok, outTok)
  if (response.stop_reason === 'refusal') throw new Error('Claude declined this request.')

  const text = (response.content as { type: string; text?: string }[])
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('')
    .trim()
  if (!text) throw new Error(`Claude returned no text (stop reason: ${response.stop_reason}).`)
  return text
}
