// ============================================================================
// TEXT HELPERS — shared by capture-url, capture-youtube and telegram-bot
// ============================================================================

// Web pages and caption files often contain codes like &amp; or &ntilde;
// instead of the real character. Turn them back into characters.
// &amp; is decoded LAST so "&amp;lt;" can't turn into a real "<".
export function decodeEntities(text: string): string {
  if (!text) return ''
  const map: Record<string, string> = {
    '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
    '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘',
    '&rdquo;': '”', '&ldquo;': '“', '&mdash;': '—',
    '&ndash;': '–', '&hellip;': '…',
    '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú',
    '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í', '&Oacute;': 'Ó', '&Uacute;': 'Ú',
    '&ntilde;': 'ñ', '&Ntilde;': 'Ñ', '&uuml;': 'ü', '&Uuml;': 'Ü',
    '&iexcl;': '¡', '&iquest;': '¿',
  }
  let out = text.replace(
    /&(lt|gt|quot|#39|apos|nbsp|rsquo|lsquo|rdquo|ldquo|mdash|ndash|hellip|[aeiouAEIOU]acute|[nN]tilde|[uU]uml|iexcl|iquest);/g,
    m => map[m] ?? m,
  )
  out = out.replace(/&#(\d+);/g, (m, n) => {
    const code = parseInt(n, 10)
    return code === 38 || code > 0x10ffff ? m : String.fromCodePoint(code)
  })
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
    const code = parseInt(h, 16)
    return code === 38 || code > 0x10ffff ? m : String.fromCodePoint(code)
  })
  return out.replace(/&amp;|&#38;|&#x26;/gi, '&')
}

// HTML -> readable text. Deliberately simple: strip the machinery (scripts,
// styles, menus, footers), then remove the remaining tags. Handles articles
// and blog posts well; not perfect on every site.
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : 'Untitled page'

  // If the page marks up its article properly, use just that part
  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    // Keep paragraph and heading breaks as newlines so structure survives
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title, text: cleaned }
}
