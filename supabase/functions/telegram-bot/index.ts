// ============================================================================
// TELEGRAM-BOT
// ============================================================================
// Text your brain from your phone.
//   - Any normal message      -> saved as a new thought
//   - ?word  or  /search word -> searches your thoughts, replies with the top 5
//   - /recent                 -> replies with your last 5 thoughts
//   - /help                   -> shows these commands
//
// DEPLOY WITH:
//   npx supabase functions deploy telegram-bot --no-verify-jwt
//
// Telegram has never heard of Supabase, so it cannot send a Supabase login
// token. Without --no-verify-jwt, Supabase turns every message away before
// this code runs and the bot looks dead. Because that door is open, this code
// checks who is knocking itself, twice:
//   1. Telegram must send the secret header we gave it during setup.
//   2. The message must come from YOUR chat (TELEGRAM_CHAT_ID).
//
// ONE-TIME SETUP, after deploying:
//   Open https://<project-ref>.supabase.co/functions/v1/telegram-bot?setup=1
//   in a browser. This function then tells Telegram where to send messages,
//   so the bot token never has to leave Supabase's secret safe.
//
// Secrets it reads (Supabase -> Edge Functions -> Secrets):
//   TELEGRAM_BOT_TOKEN  from BotFather
//   OWNER_USER_ID       your account's UID — every saved thought belongs to it
//   TELEGRAM_CHAT_ID    your chat with the bot (the bot tells you this number)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY are provided by Supabase itself
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { CaptureError, captureUrl, captureYouTube, extractVideoId } from '../_shared/capture.ts'
import { searchBrain } from '../_shared/search.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const ALLOWED_CHAT_ID = (Deno.env.get('TELEGRAM_CHAT_ID') ?? '').trim()

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// The service role key skips the Level 2 security rule entirely, so every
// query below filters by OWNER_USER_ID by hand, and every insert sets it.
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function ok(body = 'ok'): Response {
  return new Response(body, { status: 200, headers: corsHeaders })
}

// A secret Telegram sends back on every message, so we know the message
// really came from Telegram. Derived from the bot token, so there is no
// extra secret to manage.
async function webhookSecret(): Promise<string> {
  const bytes = new TextEncoder().encode('open-brain-webhook:' + BOT_TOKEN)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48)
}

async function reply(chatId: number | string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),   // Telegram's per-message limit is 4096
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    console.error('[telegram] Could not send reply:', String(err))
  }
}

function formatThought(t: { content: string; created_at: string }, n: number): string {
  const when = new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const body = t.content.replace(/\s+/g, ' ').trim()
  return `${n}. [${when}]\n${body.slice(0, 350)}${body.length > 350 ? '…' : ''}`
}

const HELP = [
  '🧠 Your Open Brain',
  '',
  '• Send any message → saved to your brain',
  '• Send a YouTube or article link → its transcript/text is saved',
  '• ?word or /search word → search your brain',
  '• /recent → your last 5 thoughts',
].join('\n')

async function setup(req: Request): Promise<Response> {
  if (!BOT_TOKEN) return ok('TELEGRAM_BOT_TOKEN is missing from your Supabase secrets.')
  const host = new URL(SUPABASE_URL).host
  const hookUrl = `https://${host}/functions/v1/telegram-bot`
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: hookUrl,
      secret_token: await webhookSecret(),
      allowed_updates: ['message'],
      drop_pending_updates: true,
    }),
  })
  const data = await res.json().catch(() => ({}))
  const msg = data.ok
    ? '✅ Connected! Telegram will now send your bot\'s messages to your brain. Go send your bot a message.'
    : '❌ Telegram said: ' + (data.description ?? 'unknown error') + ' — check TELEGRAM_BOT_TOKEN in your Supabase secrets.'
  return new Response(msg, { status: 200, headers: { ...corsHeaders, 'Content-Type': 'text/plain; charset=utf-8' } })
}

async function handleMessage(message: any): Promise<void> {
  const chatId = message.chat.id
  const text: string = (message.text ?? message.caption ?? '').trim()

  // Not set up yet: tell the owner their chat id, save nothing.
  if (!ALLOWED_CHAT_ID) {
    await reply(chatId,
      `👋 Almost there! Your chat ID is:\n\n${chatId}\n\n` +
      'Add it in Supabase → Edge Functions → Secrets as TELEGRAM_CHAT_ID, then message me again.')
    return
  }
  // Anyone else who finds the bot gets nothing from your brain.
  if (String(chatId) !== ALLOWED_CHAT_ID) {
    await reply(chatId, 'Sorry, this is a private bot.')
    return
  }
  if (!OWNER_USER_ID) {
    await reply(chatId, 'OWNER_USER_ID is missing from your Supabase secrets, so I can\'t save yet.')
    return
  }
  if (!text) {
    await reply(chatId, 'I can only save text messages for now.')
    return
  }

  if (text === '/start' || text === '/help') {
    await reply(chatId, HELP)
    return
  }

  if (text.startsWith('/recent')) {
    const { data, error } = await db
      .from('thoughts').select('content, created_at')
      .eq('user_id', OWNER_USER_ID)
      .order('created_at', { ascending: false }).limit(5)
    if (error) throw error
    await reply(chatId, data && data.length
      ? '🕘 Your last thoughts:\n\n' + data.map(formatThought).join('\n\n')
      : 'Your brain is empty so far. Send me a thought!')
    return
  }

  if (text.startsWith('?') || text.startsWith('/search')) {
    const query = text.replace(/^(\?|\/search(@\w+)?)\s*/i, '').trim()
    if (!query) {
      await reply(chatId, 'What should I look for? Try: ?prayer')
      return
    }
    // By meaning first, then anything containing the exact words
    const hits = await searchBrain(db, OWNER_USER_ID, query, 5)
    await reply(chatId, hits.length
      ? `🔍 Found ${hits.length} for "${query}":\n\n` + hits.map((h, i) =>
          formatThought(h, i + 1) + (h.similarity !== null ? `\n(${Math.round(h.similarity * 100)}% match by meaning)` : '')
        ).join('\n\n')
      : `Nothing in your brain matches "${query}" yet.`)
    return
  }

  if (text.startsWith('/')) {
    await reply(chatId, 'I don\'t know that command.\n\n' + HELP)
    return
  }

  // A message that is just a link: fetch it on the server and save the
  // transcript or article text, instead of saving the bare link.
  if (/^https?:\/\/\S+$/i.test(text)) {
    try {
      if (extractVideoId(text)) {
        const v = await captureYouTube(db, OWNER_USER_ID, text)
        await reply(chatId, v.hasTranscript
          ? `📹 Saved the transcript of "${v.title}" (${v.chars.toLocaleString()} characters).`
          : `📹 Saved "${v.title}" — no transcript was available, so I saved its description.`)
      } else {
        const a = await captureUrl(db, OWNER_USER_ID, text)
        await reply(chatId, `🔗 Saved "${a.title}" (${a.chars.toLocaleString()} characters).`)
      }
    } catch (err) {
      if (!(err instanceof CaptureError)) throw err
      await reply(chatId, `Couldn't read that link: ${err.message}`)
    }
    return
  }

  // upsert, not insert: the database refuses an identical second copy (for
  // example when Telegram re-sends a message), so a repeat updates the
  // existing thought instead of failing.
  const { error } = await db.from('thoughts').upsert({
    content: text,
    user_id: OWNER_USER_ID,
    metadata: { source: 'telegram', telegram_message_id: message.message_id },
  }, { onConflict: 'dedup_key,user_id', ignoreDuplicates: false })
  if (error) throw error
  await reply(chatId, '✅ Saved to your brain.')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return ok()

  const url = new URL(req.url)
  if (req.method === 'GET') {
    if (url.searchParams.has('setup')) return await setup(req)
    return ok('Your Open Brain Telegram bot is running.')
  }

  // Only accept messages that carry the secret we handed Telegram in setup.
  const sent = req.headers.get('x-telegram-bot-api-secret-token') ?? ''
  if (!BOT_TOKEN || sent !== await webhookSecret()) {
    return new Response('forbidden', { status: 403, headers: corsHeaders })
  }

  // Always answer Telegram with 200, even on errors — otherwise it keeps
  // re-sending the same message.
  let chatId: number | undefined
  try {
    const update = await req.json()
    const message = update.message
    if (!message?.chat) return ok()
    chatId = message.chat.id
    await handleMessage(message)
  } catch (err) {
    console.error('[telegram] Failed:', String(err))
    if (chatId !== undefined && String(chatId) === ALLOWED_CHAT_ID) {
      await reply(chatId, '⚠️ Something went wrong saving that. Try again in a moment.')
    }
  }
  return ok()
})
