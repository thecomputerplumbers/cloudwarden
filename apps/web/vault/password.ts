/** Random passwords from the browser's CSPRNG, without modulo bias. */

const SETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*-_=+?",
}

function pick(alphabet: string) {
  const limit = 256 - (256 % alphabet.length)
  for (;;) {
    const [byte] = crypto.getRandomValues(new Uint8Array(1))
    if (byte! < limit) return alphabet[byte! % alphabet.length]!
  }
}

/** At least one character from every chosen set, shuffled, without look-alikes (l, 1, O, 0). */
export function generatePassword(
  length = 20,
  sets: (keyof typeof SETS)[] = ["lower", "upper", "digits", "symbols"]
) {
  const chosen = sets.map((name) => SETS[name])
  const all = chosen.join("")
  const chars = [
    ...chosen.map(pick),
    ...Array.from({ length: Math.max(0, length - chosen.length) }, () =>
      pick(all)
    ),
  ]
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1)
    ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
  }
  return chars.join("")
}
