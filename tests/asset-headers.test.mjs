import assert from "node:assert/strict"
import { test } from "node:test"
import { assetHeaders, IMMUTABLE } from "../apps/web/scripts/asset-headers.mjs"

const rules = (text) => text.split("\n").filter((line) => line.startsWith("/"))

test("hashed web vault files are cached for good; everything else is revalidated", () => {
  const text = assetHeaders([
    "index.html",
    "manifest.json",
    "app/main.a46e2355765814789865.js",
    "app/vendor.33eb90af298c6fbb7f03.js.LICENSE.txt",
    "fonts/inter.c504db5c06caaf7cdfba.woff2",
    "theme_head.6991036cc6ce1ab5eee1.js",
    "cca56971e438d22818d6.json",
    "locales/en/messages.json",
    "images/logo.svg",
    "images/icon.0123456789abcdef0123.png",
    "assets/index-DwAbC123.js",
  ])
  assert.deepEqual(rules(text), [
    "/cca56971e438d22818d6.json",
    "/theme_head.6991036cc6ce1ab5eee1.js",
    "/app/*",
    "/assets/*",
    "/fonts/*",
    "/images/icon.0123456789abcdef0123.png",
  ])
  assert.ok(text.includes(`Cache-Control: ${IMMUTABLE}`))
  assert.ok(
    !text.includes("index.html") &&
      !text.includes("locales") &&
      !text.includes("logo.svg")
  )
})

test("a build that would exceed Cloudflare's 100 rules fails instead of dropping some", () => {
  const files = Array.from(
    { length: 101 },
    (_, i) => `${String(i).padStart(4, "0")}.${"a".repeat(20)}.js`
  )
  assert.throws(() => assetHeaders(files), /101 rules/)
})
