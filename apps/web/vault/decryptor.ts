import type { AccountKeys } from "./crypto/account.ts"
import {
  decryptCipher,
  type RawCipher,
  type VaultItem,
} from "./crypto/cipher.ts"
import type { DecryptRequest } from "./decrypt-worker.ts"

type Pending = { resolve: (items: Omit<VaultItem, "raw">[]) => void }

let worker: Worker | null = null
let failed = false
let next = 0
const pending = new Map<number, Pending>()

function start() {
  if (worker || failed || typeof Worker === "undefined") return worker
  try {
    worker = new Worker(new URL("./decrypt-worker.ts", import.meta.url), {
      type: "module",
      name: "vault-decrypt",
    })
    worker.onmessage = ({ data }) => {
      pending.get(data.id)?.resolve(data.items)
      pending.delete(data.id)
    }
    worker.onerror = () => {
      // A worker that cannot load leaves its callers to the main thread.
      failed = true
      stop()
    }
  } catch {
    failed = true
  }
  return worker
}

/** Loads the worker ahead of time, e.g. while the vault is being fetched. */
export const warmDecryptor = () => void start()

/** Ends the worker and its requests; anything waiting falls back to the main thread. */
export function stop() {
  worker?.terminate()
  worker = null
  for (const [, request] of pending) request.resolve([])
  pending.clear()
}

const onMainThread = (ciphers: RawCipher[], keys: AccountKeys) =>
  Promise.all(ciphers.map((raw) => decryptCipher(raw, keys, false)))

/**
 * Item summaries for a vault, decrypted in a Web Worker so a large vault does
 * not freeze the page, or on the main thread when no worker is available.
 */
export async function decryptSummaries(
  ciphers: RawCipher[],
  keys: AccountKeys
): Promise<VaultItem[]> {
  const target = start()
  if (!target || ciphers.length === 0) return onMainThread(ciphers, keys)
  const id = next++
  const items = await new Promise<Omit<VaultItem, "raw">[]>((resolve) => {
    pending.set(id, { resolve })
    const request: DecryptRequest = {
      id,
      ciphers,
      keys: { userKey: keys.userKey, orgKeys: keys.orgKeys },
    }
    target.postMessage(request)
  })
  // An empty answer means the worker went away: do the work here instead.
  if (items.length !== ciphers.length) return onMainThread(ciphers, keys)
  return items.map((item, index) => ({ ...item, raw: ciphers[index]! }))
}
