export function newSendOtp() {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0]!
    if (value < limit) return String(value % 1_000_000).padStart(6, "0")
  }
}

export async function sendOtpHash(
  secret: string,
  sendId: string,
  email: string,
  code: string
) {
  if (secret.length < 32) throw new Error("Send OTP secret is not configured")
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const hash = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      JSON.stringify(["cloudwarden-send-otp-v1", sendId, email, code])
    )
  )
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}
