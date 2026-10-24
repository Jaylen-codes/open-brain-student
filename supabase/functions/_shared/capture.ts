// ============================================================================
// CAPTURE — fetch a web page or a YouTube video on the server and save it.
// ============================================================================
// Used by the capture-url and capture-youtube functions (called from the web
// app) and by telegram-bot (when you text it a link).
//
// WHY THIS RUNS ON A SERVER: a web page in your browser is not allowed to go
// and read other websites (that rule is called CORS), and YouTube hides its
// subtitles from anything that isn't a person in a browser. A server has
// neither problem — which is why Level 2 needed copy-and-paste and this
// doesn't.
//
// No AI summary yet: the raw text is saved. Summarising comes in Level 5.
// ============================================================================

import { decodeEntities, htmlToText } from './text.ts'

// deno-lint-ignore no-explicit-any
type Admin = any

const SUPADATA_KEY = Deno.env.get('SUPADATA_API_KEY') ?? ''   // optional
const MAX_PAGE_BYTES = 3_000_000
const MAX_SAVED_CHARS = 200_000

export class CaptureError extends Error {}

// ---------------------------------------------------------------------------
// Saving — a plain insert, exactly like the web app does. The full text goes
// in `content` (so search finds it) and also in thought_sources (its proper
// home for later levels). The thought_sources insert is non-fatal.
// ---------------------------------------------------------------------------
async function saveCapture(
  admin: Admin, userId: string, content: string, fullText: string,
  sourceKind: string, metadata: Record<string, unknown>,
): Promise<string> {
  const { data: thought, error } = await admin.from('thoughts')
    .insert({ user_id: userId, content: content.slice(0, MAX_SAVED_CHARS), metadata })
    .select('id').single()
  if (error) throw error

  const text = fullText.slice(0, MAX_SAVED_CHARS)
  const { error: srcErr } = await admin.from('thought_sources').insert({
    thought_id: thought.id,
    user_id: userId,
    source_text: text,
    source_kind: sourceKind,
    char_count: text.length,
    truncated: fullText.length > MAX_SAVED_CHARS,
  })
  if (srcErr) console.warn('[capture] Saved the thought, but not its full source text:', srcErr.message)
  return thought.id
}

// ---------------------------------------------------------------------------
// WEB PAGES
// ---------------------------------------------------------------------------

// Stop the server from being pointed at private/internal addresses.
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true
  if (/^(0|10|127)\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true
  if (h.includes(':')) return true   // raw IPv6 addresses — not needed for articles
  return false
}

export async function captureUrl(admin: Admin, userId: string, rawUrl: string) {
  let parsed: URL
  try { parsed = new URL(rawUrl.trim()) } catch { throw new CaptureError('That is not a valid web address.') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CaptureError('Only http and https links are supported.')
  }
  if (isBlockedHost(parsed.hostname)) throw new CaptureError('That address is not allowed.')

  let res: Response
  try {
    res = await fetch(parsed.toString(), {
      headers: {
        // Identify as a normal browser — some sites refuse anything automated
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw new CaptureError(String(err).includes('timed out') || String(err).includes('Timeout')
      ? 'That page took too long to respond.'
      : 'Could not reach that page.')
  }
  if (!res.ok) {
    throw new CaptureError(`That page returned an error (HTTP ${res.status}). It may need a login or block automated readers.`)
  }
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('html') && !type.includes('text')) {
    throw new CaptureError(`That link is a ${type.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab.`)
  }
  const raw = await res.text()
  if (raw.length > MAX_PAGE_BYTES) throw new CaptureError('That page is too large to save.')

  const { title, text } = htmlToText(raw)
  if (text.length < 200) {
    throw new CaptureError(
      'Almost no readable text was found. The page probably builds itself with JavaScript, ' +
      'which a server cannot see. Paste the text in by hand instead.')
  }

  const url = parsed.toString()
  const content = `🔗 ${title}\n${url}\n\n${text}`
  const id = await saveCapture(admin, userId, content, text, 'web', {
    source: 'web', url, title, hostname: parsed.hostname,
  })
  return { id, title, chars: text.length, preview: text.slice(0, 200) }
}

// ---------------------------------------------------------------------------
// YOUTUBE
//
// YouTube serves a stripped-down page with no captions when the request comes
// from a data centre — which is what a Supabase function is. Code that works
// on your laptop fails once deployed. So we try several routes and take the
// first one that works:
//   1. SUPADATA    — a service built for this; fetches from home internet
//                    connections. Optional: needs SUPADATA_API_KEY.
//   2. INNERTUBE   — YouTube's own internal app API, posing as the iPhone and
//                    Android apps, which YouTube serves properly. No key.
//   3. DESCRIPTION — no captions anywhere? Save the description instead,
//                    clearly labelled, so you still capture something.
// ---------------------------------------------------------------------------

interface VideoContent { text: string; hasTranscript: boolean; via: string }

export function extractVideoId(url: string): string | null {
  const m = url.trim().match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/)
  return m ? m[1] : null
}

async function fetchTitle(videoId: string): Promise<string> {
  try {
    const res = await fetch(
      'https://www.youtube.com/oembed?format=json&url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + videoId),
      { signal: AbortSignal.timeout(8000) })
    if (res.ok) {
      const data = await res.json()
      if (data?.title) return decodeEntities(String(data.title))
    }
  } catch { /* use the placeholder */ }
  return `YouTube video ${videoId}`
}

async function fromSupadata(videoId: string): Promise<VideoContent | null> {
  if (!SUPADATA_KEY) return null
  try {
    const videoUrl = 'https://www.youtube.com/watch?v=' + videoId
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(25_000) })
    if (!res.ok) {
      // 402 here almost always means the free monthly allowance is used up
      console.log(`[youtube] Supadata HTTP ${res.status} — trying the next route`)
      return null
    }
    const data = await res.json()
    const content = data?.content
    const text = (typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.map((s: { text?: string }) => s.text ?? '').join(' ') : '')
    const clean = decodeEntities(text).replace(/\s+/g, ' ').trim()
    if (!clean) return null
    return { text: clean, hasTranscript: true, via: 'supadata' }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return null
  }
}

async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    {
      name: 'IOS',
      userAgent: 'com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      context: {
        clientName: 'IOS', clientVersion: '19.29.1', deviceMake: 'Apple',
        deviceModel: 'iPhone17,2', osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US',
      },
    },
    {
      name: 'ANDROID',
      userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' },
    },
  ]

  // deno-lint-ignore no-explicit-any
  let best: any = null
  for (const c of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': c.userAgent },
        body: JSON.stringify({ context: { client: c.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) { console.log(`[youtube] Innertube ${c.name} HTTP ${res.status}`); continue }
      const result = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length) { best = result; break }
      if (!best) best = result   // keep it: it still has the description
    } catch (err) {
      console.error(`[youtube] Innertube ${c.name} error:`, String(err))
    }
  }
  if (!best) return null

  try {
    const tracks = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (Array.isArray(tracks) && tracks.length) {
      // Prefer human-written English, then auto-generated English, then anything
      // deno-lint-ignore no-explicit-any
      const track = tracks.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr') ??
        // deno-lint-ignore no-explicit-any
        tracks.find((t: any) => String(t.languageCode ?? '').startsWith('en')) ?? tracks[0]
      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })
      if (capRes.ok) {
        const xml = await capRes.text()
        // Caption XML looks like: <text start="1.2" dur="3.4">words here</text>
        // (newer responses use <p ...><s>word</s></p>, so strip any inner tags)
        const pieces = [...xml.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g)]
          .map(m => decodeEntities(m[1].replace(/<[^>]+>/g, '')))
        const text = pieces.join(' ').replace(/\s+/g, ' ').trim()
        if (text) return { text, hasTranscript: true, via: 'innertube' }
      }
    }
    const details = best?.videoDetails
    const description: string = details?.shortDescription ?? ''
    const keywords: string = Array.isArray(details?.keywords) ? details.keywords.join(', ') : ''
    if (description || keywords) {
      return {
        text: [description, keywords ? `Keywords: ${keywords}` : ''].filter(Boolean).join('\n\n'),
        hasTranscript: false,
        via: 'description',
      }
    }
  } catch (err) {
    console.error('[youtube] Innertube parse error:', String(err))
  }
  return null
}

export async function captureYouTube(admin: Admin, userId: string, rawUrl: string) {
  const videoId = extractVideoId(rawUrl)
  if (!videoId) {
    throw new CaptureError('That does not look like a YouTube link. Expected something like https://www.youtube.com/watch?v=...')
  }
  const videoUrl = 'https://www.youtube.com/watch?v=' + videoId
  const title = await fetchTitle(videoId)
  const result = (await fromSupadata(videoId)) ?? (await fromInnertube(videoId))
  if (!result) {
    throw new CaptureError('Could not read anything from that video. It may be private, age-restricted or region-locked.')
  }

  const label = result.hasTranscript ? '' : '(No transcript was available — this is the video description.)\n\n'
  const content = `📹 YouTube: ${title}\n${videoUrl}\n\n${label}${result.text}`
  const id = await saveCapture(admin, userId, content, result.text,
    result.hasTranscript ? 'youtube_transcript' : 'youtube_description', {
      source: 'youtube', video_id: videoId, video_url: videoUrl, title,
      has_transcript: result.hasTranscript, fetched_via: result.via,
    })
  return {
    id, title, hasTranscript: result.hasTranscript, via: result.via,
    chars: result.text.length, preview: result.text.slice(0, 200),
  }
}
