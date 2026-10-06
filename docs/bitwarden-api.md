# Bitwarden client API

Cloudwarden serves Bitwarden-compatible routes from the Worker before vinext
handles the starter application. It uses separate D1 accounts and sessions and
selects one SQLite Durable Object per account for encrypted vault data. The
server stores client-encrypted keys and cipher fields; it never derives or
receives a master password.

Current routes cover server configuration, legacy account registration,
prelogin, password login, rotating refresh tokens, profile, personal vault
sync, personal ciphers, folders, and encrypted attachments stored in private
R2. Attachment links expire after five minutes. Registration is disabled unless
`SIGNUPS_ALLOWED=true` is configured. Open registration currently has no email
verification, so enable it only for a controlled local environment. Access
tokens are signed JWTs that clients can decode, while refresh tokens are
opaque random values. Both are stored as SHA-256 hashes in D1 and checked
against the current session on every request. Access tokens expire after one
hour and refresh tokens after 30 days. Issuing tokens requires the
`BETTER_AUTH_SECRET` signing secret.

This is an initial protocol implementation. Current clients may need routes or
response fields beyond the ones listed above. The web vault, Sends,
organizations and collections, two-factor authentication, account
recovery, notifications, and import/export still need implementation. Browser,
mobile, and desktop clients have not been tested, so this cannot yet replace
Vaultwarden.

The local smoke test runs against a real Wrangler Worker with disposable D1
and Durable Object state. It checks registration, prelogin, password login,
token rotation, encrypted item and folder sync, attachment upload/download,
and account isolation. Run
`pnpm test:worker` after a build or changes to authentication and vault data.

A disposable Bitwarden CLI 2026.2.0 account was also exercised against the
local Worker through a local HTTPS proxy. Password login, sync, encrypted item
creation and editing, folder creation, trash, and restore succeeded. This
checks a real client but does not cover every client or API route.
