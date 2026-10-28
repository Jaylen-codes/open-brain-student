// ============================================================================
// OPEN-BRAIN-MCP — the "librarian" between an AI and your brain.
// ============================================================================
// MCP (Model Context Protocol) is an open standard that lets AI apps use
// tools. This function is an MCP server: an AI asks it to search, list or
// save thoughts, and it does that against YOUR database and hands back only
// the results. The AI never sees your database keys.
//
// Tools it offers:
//   search_thoughts  find thoughts containing a word or phrase
//   list_recent      the newest thoughts
//   get_thought      the full text of one thought (transcripts can be long)
//   add_thought      save a new thought
//
// DEPLOY WITH:
//   npx supabase functions deploy open-brain-mcp --no-verify-jwt
//
// Claude can't send a Supabase login token, so Supabase's own check is
// switched off for this function. It guards itself instead: every request
// must carry the MCP_ACCESS_KEY, either as a header
//   Authorization: Bearer <MCP_ACCESS_KEY>
// or in the address itself, for Claude's "custom connector" setting, which
// has no way to add headers:
//   https://<project-ref>.supabase.co/functions/v1/open-brain-mcp?key=<MCP_ACCESS_KEY>
// Treat that full address like a password.
//
// Secrets it reads: MCP_ACCESS_KEY, OWNER_USER_ID
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from Supabase itself)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { searchBrain } from '../_shared/search.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ACCESS_KEY = Deno.env.get('MCP_ACCESS_KEY') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
// How close in meaning a thought must be to count as a search match (0–1).
const SEARCH_THRESHOLD = Number(Deno.env.get('SEARCH_THRESHOLD') ?? '0.75')

// The service role key skips the Level 2 security rules, so every query
// below filters by OWNER_USER_ID by hand, and every insert sets it.
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const SERVER_INFO = { name: 'open-brain', version: '1.0.0' }
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, accept',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Compare the key without leaking how many characters matched.
function keyMatches(given: string): boolean {
  if (!ACCESS_KEY || given.length !== ACCESS_KEY.length) return false
  let diff = 0
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ ACCESS_KEY.charCodeAt(i)
  return diff === 0
}

// ---------------------------------------------------------------------------
// The tool menu the AI reads, so it knows what it can ask for.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'search_thoughts',
    description:
      "Search the user's personal knowledge base (their 'Open Brain'). Hybrid search: it finds thoughts " +
      'about the same idea even in different words, exact names and terms, and specific passages inside ' +
      'long transcripts and articles (shown as the matching passage). ' +
      'Each result lists the thoughts it is linked to. Returns short excerpts with ids; use ' +
      'get_thought for the full text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for — a word, phrase, question or idea' },
        limit: { type: 'number', description: 'How many results (default 10, max 25)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_recent',
    description: "List the most recently saved thoughts in the user's Open Brain, newest first.",
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many (default 10, max 50)' } },
    },
  },
  {
    name: 'get_thought',
    description:
      'Read the full text of one thought by its id — for example a whole YouTube transcript, PDF ' +
      'or article that search_thoughts only showed an excerpt of.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The thought id from search or list results' } },
      required: ['id'],
    },
  },
  {
    name: 'add_thought',
    description: "Save a new thought to the user's Open Brain. Only use this when the user asks you to save something.",
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'The text to save' } },
      required: ['content'],
    },
  },
]

// ---------------------------------------------------------------------------
// Helpers for shaping results
// ---------------------------------------------------------------------------
function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

// A window of text around the first match, so a hit deep inside a long
// transcript still shows why it matched.
function excerpt(content: string, query?: string, size = 600): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= size) return flat
  const firstLine = content.split('\n')[0].slice(0, 150)
  if (!query) return flat.slice(0, size) + '…'
  const at = flat.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0 || at < size - 100) return flat.slice(0, size) + '…'
  const start = Math.max(0, at - Math.floor(size / 2))
  return `${firstLine} … ${flat.slice(start, start + size)}…`
}

function clamp(n: unknown, dflt: number, max: number): number {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) && v > 0 ? Math.min(v, max) : dflt
}

type Row = {
  id: string; content: string; created_at: string
  category?: string | null; tags?: string[] | null; summary?: string | null
}

function formatList(rows: Row[], query?: string): string {
  return rows.map((t, i) =>
    `${i + 1}. [${when(t.created_at)}] (id: ${t.id}, ${t.content.length.toLocaleString()} chars)` +
    (t.category ? `\nCategory: ${t.category}` : '') +
    (t.tags && t.tags.length ? `\nTags: ${t.tags.join(', ')}` : '') +
    (t.summary ? `\nSummary: ${t.summary}` : '') +
    `\n${excerpt(t.content, query)}`
  ).join('\n\n')
}

// ---------------------------------------------------------------------------
// What each tool does
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function callTool(name: string, args: any): Promise<string> {
  if (!OWNER_USER_ID) throw new Error('OWNER_USER_ID is not set in Supabase secrets.')

  if (name === 'search_thoughts') {
    const query = String(args?.query ?? '').trim()
    if (!query) throw new Error('query is required')
    const limit = clamp(args?.limit, 10, 25)

    // Hybrid search (meaning + keywords, including pieces of long captures)
    const results = await searchBrain(db, OWNER_USER_ID, query, limit)
    if (!results.length) return `Nothing in the brain matches "${query}", by meaning or by keywords.`

    // 3. The graph: what each result is linked to.
    const ids = results.map(r => r.id)
    const idList = ids.join(',')
    const { data: links } = await db.from('thought_links')
      .select('source_thought_id, target_thought_id, similarity_score')
      .eq('user_id', OWNER_USER_ID)
      .or(`source_thought_id.in.(${idList}),target_thought_id.in.(${idList})`)
    const neighborsOf = new Map<string, { id: string; score: number }[]>()
    for (const l of links ?? []) {
      for (const [a, b] of [[l.source_thought_id, l.target_thought_id], [l.target_thought_id, l.source_thought_id]]) {
        if (!ids.includes(a)) continue
        if (!neighborsOf.has(a)) neighborsOf.set(a, [])
        neighborsOf.get(a)!.push({ id: b, score: l.similarity_score })
      }
    }
    const neighborIds = [...new Set([...neighborsOf.values()].flat().map(n => n.id))]
    const neighborRows = new Map<string, { content: string; summary: string | null }>()
    if (neighborIds.length) {
      const { data } = await db.from('thoughts')
        .select('id, content, summary').eq('user_id', OWNER_USER_ID).in('id', neighborIds)
      for (const r of data ?? []) neighborRows.set(r.id, r)
    }

    const body = results.map((t, i) => {
      const match = typeof t.similarity === 'number'
        ? `${Math.round(t.similarity * 100)}% match by meaning`
        : 'matched by keywords'
      const piece = t.matched_chunk
        ? `\n   ↳ matching passage (from partway through a longer capture): "${t.matched_chunk.replace(/\s+/g, ' ').trim().slice(0, 700)}"`
        : ''
      const linked = (neighborsOf.get(t.id) ?? [])
        .filter(n => neighborRows.has(n.id))
        .map(n => {
          const r = neighborRows.get(n.id)!
          return `   ↳ linked (${Math.round(n.score * 100)}%): ${(r.summary || r.content).replace(/\s+/g, ' ').slice(0, 160)} (id: ${n.id})`
        })
      return formatList([t], query).replace(/^1\. /, `${i + 1}. `).replace(/\n/, ` — ${match}\n`) + piece +
        (linked.length ? '\n' + linked.join('\n') : '')
    }).join('\n\n')
    return `Found ${results.length} thought(s) for "${query}":\n\n${body}`
  }

  if (name === 'list_recent') {
    const limit = clamp(args?.limit, 10, 50)
    const { data, error } = await db.from('thoughts')
      .select('id, content, created_at, category, tags, summary')
      .eq('user_id', OWNER_USER_ID)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data.length ? `The ${data.length} most recent thoughts:\n\n${formatList(data)}` : 'The brain is empty so far.'
  }

  if (name === 'get_thought') {
    const id = String(args?.id ?? '').trim()
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('That is not a valid thought id.')
    const { data, error } = await db.from('thoughts')
      .select('id, content, created_at')
      .eq('user_id', OWNER_USER_ID)
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!data) return 'No thought with that id.'
    const MAX = 60_000
    const body = data.content.length > MAX
      ? data.content.slice(0, MAX) + `\n\n[…cut off: ${(data.content.length - MAX).toLocaleString()} more characters]`
      : data.content
    return `Saved ${when(data.created_at)} (id: ${data.id})\n\n${body}`
  }

  if (name === 'add_thought') {
    const content = String(args?.content ?? '').trim()
    if (!content) throw new Error('content is required')
    if (content.length > 100_000) throw new Error('That is too long to save as one thought.')
    const { data, error } = await db.from('thoughts')
      .upsert({ content, user_id: OWNER_USER_ID, metadata: { source: 'mcp' } },
        { onConflict: 'dedup_key,user_id', ignoreDuplicates: false })
      .select('id, created_at')
      .single()
    if (error) throw error
    return `Saved to the Open Brain (id: ${data.id}).`
  }

  throw new Error(`Unknown tool: ${name}`)
}

// ---------------------------------------------------------------------------
// MCP speaks JSON-RPC 2.0: each request has a method and an id, and each
// answer echoes the id back with a result or an error.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function handleRpc(msg: any): Promise<unknown | null> {
  const { id, method, params } = msg ?? {}
  const isNotification = id === undefined || id === null

  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions:
              "This server is the user's Open Brain: their personal collection of notes, voice notes, " +
              'YouTube transcripts, PDFs and articles. Search it when the user asks about something ' +
              'they saved, learned, watched or wrote down.',
          },
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
      case 'tools/call': {
        try {
          const text = await callTool(params?.name, params?.arguments ?? {})
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }
        } catch (err) {
          // Tool problems go back as a readable result, so the AI can explain or retry
          const message = err instanceof Error ? err.message : String((err as { message?: string })?.message ?? err)
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + message }], isError: true } }
        }
      }
      default:
        if (isNotification) return null   // e.g. notifications/initialized — nothing to answer
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    }
  } catch (err) {
    console.error('[mcp] Failed:', String(err))
    return isNotification ? null : { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  // The librarian's door check: no key, no entry.
  const auth = req.headers.get('Authorization') ?? ''
  const fromHeader = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const fromUrl = new URL(req.url).searchParams.get('key') ?? ''
  if (!keyMatches(fromHeader) && !keyMatches(fromUrl)) return json({ error: 'Unauthorized' }, 401)

  // This server only answers requests; it never pushes messages on its own.
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders })

  let body: unknown
  try { body = await req.json() } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }

  // A batch is a list of requests; answer each one.
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map(handleRpc))).filter(a => a !== null)
    return answers.length ? json(answers) : new Response(null, { status: 202, headers: corsHeaders })
  }
  const answer = await handleRpc(body)
  return answer ? json(answer) : new Response(null, { status: 202, headers: corsHeaders })
})
