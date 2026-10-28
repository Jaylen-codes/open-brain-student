// ============================================================================
// THOUGHT CHUNKS — split long captures into pieces, each with its own meaning.
// ============================================================================
// A 6,000-word transcript is ONE point on the meaning map, sitting near its
// overall gist — so a search for one detail in the middle misses it. Here a
// long thought is cut into ~1,200-character pieces (chunking.ts decides where),
// and each piece gets its own point. The thought keeps its own point too.
//
// Done in two steps, because a Supabase function only gets a couple of
// seconds of computer time per call:
//   saveThoughtChunks()  — writes the pieces (fast, no AI)
//   embedPendingChunks() — maps a few pieces per call; the caller repeats
//                          until none are left
// Neither ever throws: a chunking problem never affects the saved thought.
// ============================================================================

import { chunkText, shouldChunk } from './chunking.ts'
import { embed, toPgVector } from './embed.ts'

// deno-lint-ignore no-explicit-any
type DB = any

const ORIGIN = 'summary'   // the course's name for "chunks of the thought's own content"

export async function saveThoughtChunks(db: DB, thoughtId: string, content: string): Promise<number> {
  try {
    if (!shouldChunk(content)) return 0
    const { count } = await db.from('thought_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('thought_id', thoughtId).eq('origin', ORIGIN)
    if (count && count > 0) return 0   // already chunked

    const chunks = chunkText(content)
    if (!chunks.length) return 0
    const rows = chunks.map(c => ({
      thought_id: thoughtId, origin: ORIGIN, chunk_index: c.index,
      content: c.text, char_start: c.charStart, char_end: c.charEnd,
    }))
    const { error } = await db.from('thought_chunks')
      .upsert(rows, { onConflict: 'thought_id,origin,chunk_index', ignoreDuplicates: true })
    if (error) throw error
    return rows.length
  } catch (err) {
    console.error('[chunks] Could not save chunks:', err instanceof Error ? err.message : String(err))
    return 0
  }
}

// Maps up to `max` pieces that don't have meaning coordinates yet.
// Returns how many are still waiting afterwards.
export async function embedPendingChunks(db: DB, thoughtId: string, max = 6): Promise<number> {
  try {
    const { data, error } = await db.from('thought_chunks')
      .select('id, content').eq('thought_id', thoughtId).is('embedding', null)
      .order('chunk_index').limit(max)
    if (error) throw error
    for (const c of data ?? []) {
      const v = await embed(c.content)
      if (!v) continue
      const { error: upErr } = await db.from('thought_chunks').update({ embedding: toPgVector(v) }).eq('id', c.id)
      if (upErr) throw upErr
    }
    const { count } = await db.from('thought_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('thought_id', thoughtId).is('embedding', null)
    return count ?? 0
  } catch (err) {
    console.error('[chunks] Could not map chunks:', err instanceof Error ? err.message : String(err))
    return 0
  }
}
