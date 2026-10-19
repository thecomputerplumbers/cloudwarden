// Website icons for vault items, at Bitwarden's icon server path
// (/icons/{domain}/icon.png). Icons are fetched from the site itself so no
// third-party icon service learns which domains are in anyone's vault.
//
// This route is unauthenticated and makes outbound requests, so every host it
// contacts, including each redirect target, passes isIconDomain first.

const ICON_PATH = /^\/icons\/([^/]+)\/icon\.png$/
const SUCCESS_TTL = 7 * 24 * 60 * 60
const MISS_TTL = 24 * 60 * 60
const FETCH_TIMEOUT_MS = 4_000
const LOOKUP_BUDGET_MS = 12_000
const MAX_REDIRECTS = 3
const MAX_HTML_BYTES = 256 * 1024
const MAX_ICON_BYTES = 200 * 1024
// Declared icons tried before falling back to /favicon.ico.
const MAX_CANDIDATES = 3

// Special-use and private-network names that public DNS should never answer.
const BLOCKED_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "corp",
  "intranet",
  "arpa",
  "test",
  "invalid",
  "example",
  "onion",
]

const IMAGE_TYPES = new Set([
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/jpeg",
  "image/webp",
  "image/gif",
])

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'",
}

export function isIconPath(path: string) {
  return ICON_PATH.test(path)
}

/**
 * Returns the lowercased hostname if it is a public DNS name the icon fetcher
 * may contact, or null. IP literals, ports and private-use names are refused.
 */
export function normalizeIconDomain(input: string) {
  const domain = input.toLowerCase()
  if (domain.length > 253 || !domain.includes(".")) return null
  const labels = domain.split(".")
  if (
    !labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    )
  )
    return null
  // The URL parser reads a host whose last label is a number (decimal or
  // 0x hex) as IPv4, so 127.1 and 0x7f.0x1 are both loopback.
  if (/^(?:\d+|0x[0-9a-f]*)$/.test(labels.at(-1)!)) return null
  if (
    BLOCKED_SUFFIXES.some(
      (suffix) => domain === suffix || domain.endsWith(`.${suffix}`)
    )
  )
    return null
  // Belt and braces: the hostname must survive URL parsing unchanged.
  try {
    if (new URL(`https://${domain}/`).hostname !== domain) return null
  } catch {
    return null
  }
  return domain
}

export type IconCandidate = { href: string; size: number; apple: boolean }

function decodeEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function attributes(tag: string) {
  const found = new Map<string, string>()
  const pattern =
    /([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
  for (const match of tag.matchAll(pattern)) {
    const name = match[1]!.toLowerCase()
    if (!found.has(name))
      found.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""))
  }
  return found
}

/**
 * Icon links declared in a page, best first: apple-touch-icon, then the
 * largest declared size of at least 32px, then undeclared sizes, then smaller
 * icons. Only https URLs are returned; SVG is skipped because it can carry
 * script and is never served back.
 */
export function iconCandidates(html: string, pageUrl: string) {
  const source = html.replace(/<!--[\s\S]*?-->/g, "")
  let base = pageUrl
  const baseTag = /<base\b[^>]*>/i.exec(source)
  const baseHref = baseTag && attributes(baseTag[0]).get("href")
  if (baseHref) {
    try {
      const resolved = new URL(baseHref, pageUrl)
      if (resolved.protocol === "https:") base = resolved.href
    } catch {
      // A malformed <base> is ignored, as browsers do.
    }
  }
  const candidates: IconCandidate[] = []
  const seen = new Set<string>()
  for (const [tag] of source.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(tag)
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/)
    const apple =
      rel.includes("apple-touch-icon") ||
      rel.includes("apple-touch-icon-precomposed")
    if (!apple && !rel.includes("icon")) continue
    const href = attrs.get("href")?.trim()
    if (!href) continue
    if ((attrs.get("type") ?? "").toLowerCase().includes("svg")) continue
    let url: URL
    try {
      url = new URL(href, base)
    } catch {
      continue
    }
    if (url.protocol !== "https:" || /\.svgz?$/i.test(url.pathname)) continue
    url.hash = ""
    if (seen.has(url.href)) continue
    seen.add(url.href)
    const sizes = (attrs.get("sizes") ?? "").toLowerCase()
    const size = Math.max(
      0,
      ...[...sizes.matchAll(/(\d+)x(\d+)/g)].map((m) =>
        Math.min(Number(m[1]), Number(m[2]))
      )
    )
    candidates.push({ href: url.href, size, apple })
  }
  const rank = (icon: IconCandidate) =>
    icon.apple ? 3 : icon.size >= 32 ? 2 : icon.size === 0 ? 1 : 0
  return candidates.sort((a, b) => rank(b) - rank(a) || b.size - a.size)
}

/** The image type from its leading bytes; served instead of the upstream header. */
export function sniffImageType(bytes: Uint8Array) {
  const starts = (...prefix: number[]) =>
    prefix.every((byte, i) => bytes[i] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon"
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg"
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif"
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp"
  return null
}

/**
 * Reads at most limit bytes. An oversized body is refused, or with truncate
 * cut short: icon links live in <head>, so the start of a page is enough.
 */
export async function readCapped(
  response: Response,
  limit: number,
  truncate: boolean
) {
  const declared = Number(response.headers.get("Content-Length") ?? 0)
  if ((declared > limit && !truncate) || !response.body) {
    await response.body?.cancel()
    return null
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (total + value.byteLength > limit) {
      await reader.cancel()
      if (!truncate) return null
      chunks.push(value.subarray(0, limit - total))
      total = limit
      break
    }
    total += value.byteLength
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * GETs an https URL on a validated public host, following at most
 * MAX_REDIRECTS redirects and revalidating each target. Returns null on any
 * failure, timeout, refused oversized body or unexpected content type.
 */
async function fetchCapped(
  start: string,
  accept: (contentType: string) => boolean,
  limit: number,
  truncate: boolean,
  deadline: number,
  self: string
) {
  let target = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = new URL(target)
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hostname === self ||
      normalizeIconDomain(url.hostname) !== url.hostname
    )
      return null
    const remaining = Math.min(FETCH_TIMEOUT_MS, deadline - Date.now())
    if (remaining <= 0) return null
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
        headers: {
          Accept: "text/html,image/*;q=0.9,*/*;q=0.1",
          "User-Agent": "Cloudwarden-Icons/1.0",
        },
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get("Location")
        if (!location) return null
        target = new URL(location, url).href
        continue
      }
      const contentType = (response.headers.get("Content-Type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase()
      if (!response.ok || !accept(contentType)) {
        await response.body?.cancel()
        return null
      }
      const bytes = await readCapped(response, limit, truncate)
      return bytes && { bytes, url: url.href }
    } catch {
      return null
    }
  }
  return null
}

async function fetchIcon(
  url: string,
  deadline: number,
  self: string
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
  const result = await fetchCapped(
    url,
    (type) => IMAGE_TYPES.has(type),
    MAX_ICON_BYTES,
    false,
    deadline,
    self
  )
  const type = result && sniffImageType(result.bytes)
  return type ? { bytes: result.bytes, type } : null
}

async function lookupIcon(domain: string, self: string) {
  const deadline = Date.now() + LOOKUP_BUDGET_MS
  const page = await fetchCapped(
    `https://${domain}/`,
    (type) => type === "text/html" || type === "application/xhtml+xml",
    MAX_HTML_BYTES,
    true,
    deadline,
    self
  )
  if (page) {
    const html = new TextDecoder().decode(page.bytes)
    for (const candidate of iconCandidates(html, page.url).slice(
      0,
      MAX_CANDIDATES
    )) {
      const icon = await fetchIcon(candidate.href, deadline, self)
      if (icon) return icon
    }
  }
  return fetchIcon(`https://${domain}/favicon.ico`, deadline, self)
}

function notFound(maxAge: number) {
  return new Response("Icon not found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      ...SECURITY_HEADERS,
    },
  })
}

function withoutBody(response: Response, method: string) {
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response
}

/** GET|HEAD /icons/{domain}/icon.png (also /legacy/icons/...). */
export async function handleIcon(
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext
) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    })
  const url = new URL(request.url)
  const raw = ICON_PATH.exec(url.pathname.toLowerCase())?.[1]
  const domain = raw ? normalizeIconDomain(raw) : null
  if (!domain) return notFound(MISS_TTL)

  // One cache entry per domain, shared by the root and /legacy/ routes.
  // The DOM lib's CacheStorage type shadows workerd's, which adds default.
  const cache = (caches as CacheStorage & { default: Cache }).default
  const key = new Request(`${url.origin}/icons/${domain}/icon.png`)
  const cached = await cache.match(key)
  if (cached) return withoutBody(cached, request.method)

  // Uncached lookups make outbound requests, so they are rate limited per
  // client. A limited request is not cached and the client retries later.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown"
  const limiter = env.APP_DATABASE.getByName("bitwarden-icon-rates")
  if (!(await limiter.consumeRateLimit(`icon:${ip}`, 120, 60_000)).allowed)
    return new Response("Too many icon requests", {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": "60" },
    })

  const icon = await lookupIcon(domain, url.hostname)
  const response = icon
    ? new Response(icon.bytes, {
        headers: {
          "Content-Type": icon.type,
          "Cache-Control": `public, max-age=${SUCCESS_TTL}`,
          ...SECURITY_HEADERS,
        },
      })
    : notFound(MISS_TTL)
  ctx.waitUntil(cache.put(key, response.clone()))
  return withoutBody(response, request.method)
}
