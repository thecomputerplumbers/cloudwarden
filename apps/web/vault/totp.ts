import { buffer } from "./crypto/bytes.ts"

/**
 * TOTP codes (RFC 6238) from what Bitwarden stores in `login.totp`: a bare
 * base32 secret, an `otpauth://totp/...` URI, or a `steam://` secret.
 */

export interface TotpConfig {
  secret: Uint8Array
  digits: number
  period: number
  algorithm: "SHA-1" | "SHA-256" | "SHA-512"
  steam: boolean
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const STEAM = "23456789BCDFGHJKMNPQRTVWXY"

function base32(text: string) {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "")
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index === -1) throw new Error("Not a base32 secret")
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(bytes)
}

export function parseTotp(text: string): TotpConfig | null {
  try {
    const trimmed = text.trim()
    if (trimmed.toLowerCase().startsWith("steam://"))
      return {
        secret: base32(trimmed.slice(8)),
        digits: 5,
        period: 30,
        algorithm: "SHA-1",
        steam: true,
      }
    if (trimmed.toLowerCase().startsWith("otpauth://")) {
      const url = new URL(trimmed)
      const algorithm = (url.searchParams.get("algorithm") ?? "SHA1")
        .toUpperCase()
        .replace("SHA", "SHA-") as TotpConfig["algorithm"]
      return {
        secret: base32(url.searchParams.get("secret") ?? ""),
        digits: Number(url.searchParams.get("digits") ?? 6),
        period: Number(url.searchParams.get("period") ?? 30),
        algorithm: ["SHA-1", "SHA-256", "SHA-512"].includes(algorithm)
          ? algorithm
          : "SHA-1",
        steam: false,
      }
    }
    return {
      secret: base32(trimmed),
      digits: 6,
      period: 30,
      algorithm: "SHA-1",
      steam: false,
    }
  } catch {
    return null
  }
}

/** The code for `now` (ms), and how many seconds it has left. */
export async function totpCode(config: TotpConfig, now = Date.now()) {
  const counter = Math.floor(now / 1000 / config.period)
  const message = new Uint8Array(8)
  new DataView(message.buffer).setBigUint64(0, BigInt(counter))
  const key = await crypto.subtle.importKey(
    "raw",
    buffer(config.secret),
    { name: "HMAC", hash: config.algorithm },
    false,
    ["sign"]
  )
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message))
  const offset = mac[mac.length - 1]! & 0x0f
  let binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!
  let code: string
  if (config.steam) {
    code = ""
    for (let i = 0; i < config.digits; i++) {
      code += STEAM[binary % STEAM.length]
      binary = Math.floor(binary / STEAM.length)
    }
  } else
    code = String(binary % 10 ** config.digits).padStart(config.digits, "0")
  return {
    code,
    remaining: config.period - (Math.floor(now / 1000) % config.period),
    period: config.period,
  }
}
