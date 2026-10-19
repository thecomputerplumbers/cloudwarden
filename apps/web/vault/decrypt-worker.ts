/// <reference lib="webworker" />
import type { AccountKeys } from "./crypto/account.ts"
import { decryptCipher, type RawCipher } from "./crypto/cipher.ts"

/**
 * Decrypts item summaries off the main thread. Each message carries the
 * vault keys it needs and nothing is kept between messages, so the worker
 * holds no keys once it has answered. Items come back without `raw`, which
 * the page already has.
 */
export type DecryptRequest = {
  id: number
  ciphers: RawCipher[]
  keys: Pick<AccountKeys, "userKey" | "orgKeys">
}

self.onmessage = async ({ data }: MessageEvent<DecryptRequest>) => {
  const keys: AccountKeys = { ...data.keys, privateKey: null }
  const items = await Promise.all(
    data.ciphers.map(async (raw) => {
      const { raw: _raw, ...item } = await decryptCipher(raw, keys, false)
      return item
    })
  )
  self.postMessage({ id: data.id, items })
}
