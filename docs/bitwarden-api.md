# Bitwarden client API

Cloudwarden serves Bitwarden-compatible routes from the Worker before vinext
handles the starter application. It uses separate D1 accounts and sessions and
selects one SQLite Durable Object per account for encrypted vault data. The
server stores client-encrypted keys and cipher fields; it never derives or
receives a master password.

Current routes cover server configuration, legacy account registration,
prelogin, password login, rotating refresh tokens, profile, personal vault
sync, personal ciphers, and folders. Registration is disabled unless
`SIGNUPS_ALLOWED=true` is configured. Open registration currently has no email
verification, so enable it only for a controlled local environment. Tokens
are opaque random values stored as SHA-256 hashes in D1; access tokens expire
after one hour and refresh tokens after 30 days.

This is an initial protocol implementation. Current clients may need routes or
response fields beyond the ones listed above. The web vault, attachments,
Sends, organizations and collections, two-factor authentication, account
recovery, notifications, and import/export still need implementation and
client-level interoperability tests before this can replace Vaultwarden.

The local smoke test runs against a real Wrangler Worker with disposable D1
and Durable Object state. It checks registration, prelogin, password login,
token rotation, encrypted item and folder sync, and account isolation. Run
`pnpm test:worker` after a build or changes to authentication and vault data.
