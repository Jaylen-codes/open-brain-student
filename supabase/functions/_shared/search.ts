// ============================================================================
// SEARCH — hybrid: by meaning AND by keywords, fused into one ranking.
// ============================================================================
// Used by telegram-bot (?word), search-brain (the web app's Search tab) and
// open-brain-mcp (Claude). All the ranking happens in the database function
// search_thoughts (see level7.sql): it compares the question's meaning with
// each thought AND each chunk of long captures, runs a keyword search too,
// and combines the two lists by rank.
// ============================================================================

import { embed, toPgVector } from './embed.ts'

// deno-lint-ignore no-explicit-any
type DB = any

export type Hit = {
  id: string; content: string; created_at: string
  category: string | null; tags: string[] | null; summary: string | null
  similarity: number | null      // meaning score (null = found by keywords only)
  matched_chunk: string | null   // the piece of a long capture that matched, if any
  match_source: 'thought' | 'chunk'
  fusion_score: number
}

const SEARCH_THRESHOLD = Number(Deno.env.get('SEARCH_THRESHOLD') ?? '0.75')

export async function searchBrain(db: DB, userId: string, query: string, limit = 10): Promise<Hit[]> {
  // If mapping the question fails, still search — by keywords alone.
  const vector = await embed(query)
  const { data, error } = await db.rpc('search_thoughts', {
    query_text: query,
    p_user_id: userId,
    query_embedding: vector ? toPgVector(vector) : null,
    match_threshold: SEARCH_THRESHOLD,
    match_count: limit,
    max_per_document: 2,
  })
  if (error) throw error
  return (data ?? []) as Hit[]
}
