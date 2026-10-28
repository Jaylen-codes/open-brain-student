// ============================================================================
// SEARCH — find thoughts by meaning, plus any containing the exact words.
// ============================================================================
// Used by telegram-bot (?word) and search-brain (the web app's Search tab).
// open-brain-mcp does the same thing and also lists each result's links.
// ============================================================================

import { embed, toPgVector } from './embed.ts'

// deno-lint-ignore no-explicit-any
type DB = any

export type Hit = {
  id: string; content: string; created_at: string
  category: string | null; tags: string[] | null; summary: string | null
  similarity: number | null   // null = matched by exact words only
}

const SEARCH_THRESHOLD = Number(Deno.env.get('SEARCH_THRESHOLD') ?? '0.75')

export async function searchBrain(db: DB, userId: string, query: string, limit = 10): Promise<Hit[]> {
  let byMeaning: Hit[] = []
  const vector = await embed(query)
  if (vector) {
    const { data, error } = await db.rpc('search_thoughts', {
      query_embedding: toPgVector(vector),
      match_threshold: SEARCH_THRESHOLD,
      match_count: limit,
      p_user_id: userId,
    })
    if (error) throw error
    byMeaning = data ?? []
  }

  const pattern = '%' + query.replace(/[\\%_]/g, m => '\\' + m) + '%'
  const { data: byWords, error } = await db.from('thoughts')
    .select('id, content, created_at, category, tags, summary')
    .eq('user_id', userId)
    .ilike('content', pattern)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error

  const seen = new Set(byMeaning.map(h => h.id))
  return [
    ...byMeaning,
    ...((byWords ?? []) as Hit[]).filter(h => !seen.has(h.id)).map(h => ({ ...h, similarity: null })),
  ].slice(0, limit)
}
