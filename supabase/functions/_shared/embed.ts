// ============================================================================
// EMBEDDINGS — turn text into its "meaning coordinates".
// ============================================================================
// Same gateway idea as llm.ts: every embedding goes through embed(), so the
// provider is one setting.
//
//   EMBED_PROVIDER = 'supabase' (default) — Supabase's built-in gte-small
//                    model. Free, runs inside your own functions, no key.
//                    Reads roughly the first 400 words of a text.
//   EMBED_PROVIDER = 'openrouter'         — needs OPENROUTER_API_KEY; uses
//                    openai/text-embedding-3-small, asked for 384 numbers
//                    so it fits the same column.
//
// The database column holds exactly 384 numbers. A provider that can't give
// 384 needs a new column and a re-map of every thought.
// ============================================================================

export const EMBED_DIMENSIONS = 384

const PROVIDER = (Deno.env.get('EMBED_PROVIDER') ?? 'supabase').trim().toLowerCase()

// deno-lint-ignore no-explicit-any
let session: any = null

async function viaSupabase(text: string): Promise<number[]> {
  // deno-lint-ignore no-explicit-any
  const ai = (globalThis as any).Supabase?.ai
  if (!ai) throw new Error('Supabase built-in AI is not available in this function.')
  session ??= new ai.Session('gte-small')
  const out = await session.run(text, { mean_pool: true, normalize: true })
  return Array.from(out as ArrayLike<number>)
}

async function viaOpenRouter(text: string): Promise<number[]> {
  const key = Deno.env.get('OPENROUTER_API_KEY')
  if (!key) throw new Error('OPENROUTER_API_KEY is not set in Supabase secrets.')
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: text, dimensions: EMBED_DIMENSIONS }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}`)
  const data = await res.json()
  return data?.data?.[0]?.embedding ?? []
}

// Returns null instead of throwing, so a failed embedding never breaks a save.
export async function embed(text: string): Promise<number[] | null> {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000)
  if (!clean) return null
  try {
    const v = PROVIDER === 'openrouter' ? await viaOpenRouter(clean) : await viaSupabase(clean)
    if (v.length !== EMBED_DIMENSIONS) throw new Error(`expected ${EMBED_DIMENSIONS} numbers, got ${v.length}`)
    return v
  } catch (err) {
    console.error('[embed] Failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// What gets embedded for a saved thought: its summary and tags first (so a
// long transcript is placed by its gist), then the start of the text itself.
export function embeddingText(t: { content: string; summary?: string | null; tags?: string[] | null }): string {
  const head = [t.summary ?? '', t.tags && t.tags.length ? t.tags.join(', ') : ''].filter(Boolean).join('. ')
  return head ? `${head}\n\n${t.content}` : t.content
}

// pgvector accepts a vector written like '[0.1,0.2,...]'
export function toPgVector(v: number[]): string {
  return '[' + v.join(',') + ']'
}
