// ============================================================================
// SYSTEM MAP — turns your Command Center into text an AI can read.
// ============================================================================
// The Board and the Coach both need the same picture: which agents exist,
// what they're for, and what each one can touch. This builds it.
// ============================================================================

// deno-lint-ignore no-explicit-any
type DB = any

export type Node = {
  id: string; kind: 'agent' | 'section' | 'board'; name: string; emoji: string
  description: string; status: string; runs_on: string; instructions: string
  parent_id: string | null
}
export type Connection = { node_id: string; system: string; access: string; detail: string; url: string }

export async function loadSystem(db: DB, userId: string) {
  const [{ data: nodes, error: e1 }, { data: conns, error: e2 }] = await Promise.all([
    db.from('cc_nodes').select('id, kind, name, emoji, description, status, runs_on, instructions, parent_id')
      .eq('user_id', userId).order('sort').order('created_at'),
    db.from('cc_connections').select('node_id, system, access, detail, url').eq('user_id', userId),
  ])
  if (e1) throw e1
  if (e2) throw e2
  return { nodes: (nodes ?? []) as Node[], conns: (conns ?? []) as Connection[] }
}

export function connectionsOf(conns: Connection[], nodeId: string) {
  return conns.filter(c => c.node_id === nodeId)
}

function describe(n: Node, conns: Connection[], indent = '') {
  const lines = [`${indent}- ${n.emoji} ${n.name} [${n.kind}, ${n.status}${n.runs_on ? `, runs on ${n.runs_on}` : ''}]`]
  if (n.description) lines.push(`${indent}  What it does: ${n.description}`)
  const mine = connectionsOf(conns, n.id)
  if (mine.length) {
    lines.push(`${indent}  Can access: ` + mine.map(c => `${c.system} (${c.access}${c.detail ? `: ${c.detail}` : ''})`).join('; '))
  } else if (n.kind !== 'board') {
    lines.push(`${indent}  Can access: nothing recorded yet`)
  }
  return lines.join('\n')
}

// The whole map as indented text: board on top, then sections with the
// agents inside them, then agents that belong to no section.
export function renderSystem(nodes: Node[], conns: Connection[]): string {
  if (!nodes.length) return '(The map is empty — nothing has been added yet.)'
  const board = nodes.filter(n => n.kind === 'board')
  const sections = nodes.filter(n => n.kind === 'section')
  const agents = nodes.filter(n => n.kind === 'agent')
  const out: string[] = ['THE BRAIN (center): Open Brain — the owner\'s personal knowledge base.']
  if (board.length) {
    out.push('', 'BOARD OF DIRECTORS (sits above the brain, gives outside judgement):')
    board.forEach(n => out.push(`- ${n.emoji} ${n.name}${n.description ? ` — ${n.description}` : ''}`))
  }
  if (sections.length) {
    out.push('', 'SECTIONS connected to the brain:')
    for (const s of sections) {
      out.push(describe(s, conns))
      agents.filter(a => a.parent_id === s.id).forEach(a => out.push(describe(a, conns, '    ')))
    }
  }
  const loose = agents.filter(a => !a.parent_id || !sections.some(s => s.id === a.parent_id))
  if (loose.length) {
    out.push('', 'AGENTS connected directly to the brain:')
    loose.forEach(a => out.push(describe(a, conns)))
  }
  return out.join('\n')
}

export function renderHits(hits: { content: string; summary: string | null; created_at: string; matched_chunk?: string | null }[]): string {
  if (!hits.length) return '(Nothing related found in the brain.)'
  return hits.map(h => {
    const body = (h.matched_chunk || h.summary || h.content || '').replace(/\s+/g, ' ').slice(0, 600)
    return `- [${h.created_at.slice(0, 10)}] ${body}`
  }).join('\n')
}
