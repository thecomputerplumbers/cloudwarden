import assert from "node:assert/strict"
import { test } from "node:test"
import {
  iconCandidates,
  isIconPath,
  normalizeIconDomain,
  readCapped,
  sniffImageType,
} from "../apps/web/worker/icons.ts"

test("icon domains accept public DNS names and normalize case", () => {
  assert.equal(normalizeIconDomain("example.com"), "example.com")
  assert.equal(
    normalizeIconDomain("Vault.Bitwarden.COM"),
    "vault.bitwarden.com"
  )
  assert.equal(
    normalizeIconDomain("xn--bcher-kva.example.org"),
    "xn--bcher-kva.example.org"
  )
  assert.equal(normalizeIconDomain("a-b.co.uk"), "a-b.co.uk")
  assert.equal(normalizeIconDomain("123.example.com"), "123.example.com")
})

test("icon domains refuse IP literals, ports and private names", () => {
  for (const host of [
    "127.0.0.1",
    "10.0.0.1",
    "127.1",
    "0x7f.0x1",
    "foo.0x7f",
    "2130706433",
    "[::1]",
    "::1",
    "fe80::1",
    "localhost",
    "foo.localhost",
    "printer.local",
    "metadata.google.internal",
    "router.lan",
    "nas.home.arpa",
    "1.0.0.127.in-addr.arpa",
    "example.com:8443",
    "user@example.com",
    "example.com.",
    ".example.com",
    "exa_mple.com",
    "-example.com",
    "example-.com",
    "example..com",
    "bücher.example",
    "example.com/path",
    "com",
    "",
  ])
    assert.equal(normalizeIconDomain(host), null, host)
})

test("icon domains enforce label and total length limits", () => {
  const label63 = "a".repeat(63)
  assert.equal(normalizeIconDomain(`${label63}.com`), `${label63}.com`)
  assert.equal(normalizeIconDomain(`${"a".repeat(64)}.com`), null)
  const long = `${Array.from({ length: 4 }, () => label63).join(".")}.com`
  assert.ok(long.length > 253)
  assert.equal(normalizeIconDomain(long), null)
})

test("icon paths match Bitwarden's icon server layout only", () => {
  assert.equal(isIconPath("/icons/example.com/icon.png"), true)
  assert.equal(isIconPath("/icons/example.com/icon.ico"), false)
  assert.equal(isIconPath("/icons/example.com/x/icon.png"), false)
  assert.equal(isIconPath("/icons//icon.png"), false)
})

test("icon links prefer apple-touch-icon, then the largest size of at least 32px", () => {
  const html = `<!doctype html><html><head>
    <!-- <link rel="apple-touch-icon" href="/commented.png"> -->
    <link rel="icon" href="/favicon-16.png" sizes="16x16">
    <link rel="shortcut icon" href="/favicon.ico">
    <link href='/favicon-64.png' sizes="64x64" rel=icon>
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <link rel="icon" href="/mask.svg">
    <link rel="icon" href="/favicon-32.png" sizes="16x16 32x32">
    <link rel="stylesheet" href="/site.css">
    <link rel="icon" href="http://example.com/insecure.png" sizes="512x512">
    <link rel="icon" href="data:image/png;base64,AAAA">
    <link rel="Apple-Touch-Icon" href="img/touch.png?v=1&amp;x=2">
  </head></html>`
  assert.deepEqual(
    iconCandidates(html, "https://example.com/app/").map((c) => c.href),
    [
      "https://example.com/app/img/touch.png?v=1&x=2",
      "https://example.com/favicon-64.png",
      "https://example.com/favicon-32.png",
      "https://example.com/favicon.ico",
      "https://example.com/favicon-16.png",
    ]
  )
})

test("icon links resolve against an https <base> and drop duplicates", () => {
  const html = `<base href="https://cdn.example.net/assets/">
    <link rel="icon" href="icon.png#a"><link rel="icon" href="icon.png#b">`
  assert.deepEqual(
    iconCandidates(html, "https://example.com/").map((c) => c.href),
    ["https://cdn.example.net/assets/icon.png"]
  )
  assert.deepEqual(
    iconCandidates(
      `<base href="http://evil.example/"><link rel="icon" href="i.png">`,
      "https://example.com/"
    ).map((c) => c.href),
    ["https://example.com/i.png"]
  )
  assert.deepEqual(
    iconCandidates("<p>no icons</p>", "https://example.com/"),
    []
  )
})

test("icon bytes are typed by their signature, never SVG or HTML", () => {
  const bytes = (...values) => new Uint8Array(values)
  assert.equal(
    sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)),
    "image/png"
  )
  assert.equal(sniffImageType(bytes(0, 0, 1, 0, 1, 0)), "image/x-icon")
  assert.equal(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg")
  assert.equal(sniffImageType(new TextEncoder().encode("GIF89a")), "image/gif")
  assert.equal(
    sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")),
    "image/webp"
  )
  assert.equal(sniffImageType(new TextEncoder().encode("<svg onload=x>")), null)
  assert.equal(sniffImageType(new TextEncoder().encode("<html>")), null)
  assert.equal(sniffImageType(bytes()), null)
})

test("icon reads refuse oversized images but truncate oversized pages", async () => {
  const body = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(6).fill(1))
          controller.enqueue(new Uint8Array(6).fill(2))
          controller.close()
        },
      })
    )
  assert.equal(await readCapped(body(), 8, false), null)
  assert.deepEqual(
    [...(await readCapped(body(), 8, true))],
    [1, 1, 1, 1, 1, 1, 2, 2]
  )
  assert.equal((await readCapped(body(), 12, false)).length, 12)
  const declared = new Response("x", { headers: { "Content-Length": "999" } })
  assert.equal(await readCapped(declared, 8, false), null)
})
