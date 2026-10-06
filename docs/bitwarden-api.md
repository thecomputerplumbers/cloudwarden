# Bitwarden client API

Cloudwarden serves Bitwarden-compatible routes from the Worker before vinext
handles the starter application. It uses separate D1 accounts and sessions and
selects one SQLite Durable Object per account for encrypted vault data. The
server stores client-encrypted keys and cipher fields; it never derives or
receives a master password.

Production builds download the pinned Vaultwarden web vault v2026.7.0 release,
verify its SHA-256 checksum, and package its static files at `/`. The release
is from [Vaultwarden's web vault builds](https://github.com/dani-garcia/bw_web_builds/tree/v2026.7.0)
under GPL-3.0; `web-vault-source.txt` ships with the assets. The archive is
cached under `apps/web/.cache/` for repeat builds. The web vault requires HTTPS
even on localhost. Signup and basic vault use passed in isolated Chrome against
a local HTTPS Worker; a trusted HTTPS deployment has not been tested.

Current routes cover server configuration, invite-based legacy account
registration, the web vault's start/finish registration flow with a short-lived signed token,
prelogin, password login, master password and PBKDF2 setting changes, rotating
refresh tokens, profile and asymmetric key updates, personal vault sync,
personal ciphers, folders, encrypted text and file Sends with public password
and access limits, and encrypted attachments stored in private R2. Send content
and access counters live in the owner's Durable Object; D1 maps public Send IDs
to that object. File Send uploads are currently capped at 20 MB. It also
supports authenticator app TOTP enrollment, login challenges,
single-use recovery codes, and disabling the factor. Optional email two-factor
uses the native Cloudflare Email Service when `EMAIL_2FA_ENABLED=true` and
`EMAIL_FROM` is configured with a verified sender. A six-digit code expires
after ten minutes and can be used once. Enrolling an email address requires
the account password and verification of a code sent to that address. Login
codes are rate limited; recovery disables all active two-factor methods.
TOTP codes cannot be replayed, and enrolling a factor revokes other sessions.
Attachment links
expire after five minutes. Registration is disabled unless
`SIGNUPS_ALLOWED=true` is configured. Registration emails a signed verification
link by default and requires that link to finish; a legacy direct registration
request is rejected. Set `SIGNUPS_VERIFY=false` only for local development with
simulated mail. Access
tokens are signed JWTs that clients can decode, while refresh tokens are
opaque random values. Both are stored as SHA-256 hashes in D1 and checked
against the current session on every request. Access tokens expire after one
hour and refresh tokens after 30 days. After a refresh, the previous access
token remains valid for at most 30 seconds so in-flight browser requests can
finish; the previous refresh token cannot be reused. Issuing tokens requires the
`BETTER_AUTH_SECRET` signing secret.

`POST /api/accounts/api-key` returns a personal API key after master-password
reauthentication; `POST /api/accounts/rotate-api-key` replaces it. The key is
encrypted at rest in D1 and checked by hash. A client can log in with
`grant_type=client_credentials`, `client_id=user.<account UUID>`, `scope=api`,
and the key as `client_secret`. These sessions have no refresh token. Rotation
revokes existing API-key sessions, including a concurrent login that presents
the old key. The API-key endpoints also accept an active authenticator or email
two-factor code in `otp`; they do not yet implement Vaultwarden's separate
protected-action OTP flow for accounts without a master password.

Personal vault import accepts the web client's encrypted folders, ciphers, and
folder relationships in one Durable Object transaction; existing folder IDs
are reused when they belong to the account. Browser CSV import and unencrypted
JSON export were exercised locally in isolated Chrome; the exported JSON
contained the imported folder and both personal items. Other export formats
and server-side export remain unverified.

Optional OIDC sign-in for the bundled web vault uses the fork's confidential
provider client. Configure `SSO_AUTHORITY` as the exact issuer,
`SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `SSO_IDENTIFIER`, and
`SSO_CALLBACK_URL` as the exact registered HTTPS callback. The browser flow
requires S256 PKCE, a signed prevalidation token, a short-lived browser binding
cookie, and a verified provider ID token with a matching nonce. Only verified
email identities may create or associate accounts. A new SSO account starts
without encryption keys; `/api/accounts/set-password` lets the authenticated
client supply its locally encrypted keys and client-derived password hash.
Password registration remains separately controlled by `SIGNUPS_ALLOWED`.
SSO refresh tokens are encrypted in D1 and redeemed with the provider when a
Cloudwarden session refreshes. The current SSO flow is implemented for the web
vault's `web` and `browser` client types; native mobile, desktop, and CLI SSO
flows still need implementation and testing.

Organization creation stores client-encrypted organization keys, an owner
membership, and a default collection in D1. Profile and sync expose the current
member's wrapped key and available collections. Collection reads and writes
recheck confirmed membership; only owners and admins can create collections.
Shared cipher IDs and collection assignments live in D1; encrypted cipher data
resides in an organization Durable Object. Sync and item routes check current
membership and collection access before reading it. Owners and admins can create
and edit shared ciphers. Shared attachments use private R2 objects under an
organization prefix; download links recheck the requester's current collection
access, and organization deletion removes those objects. Owners and admins can
change a shared cipher's collection assignments; the new mapping takes effect
for reads and attachment links immediately. Attachment tokens are bound to the
requesting user in the Durable Object; changing the user ID in a download URL
cannot transfer access. `POST` and `PUT /api/ciphers/:id/share` move an existing
personal cipher into an organization collection. The client supplies an
organization-encrypted cipher and rewrapped attachment keys. A D1 transfer
record and a frozen source cipher let the scheduled handler resume an
interrupted R2 copy or source cleanup. The transfer waits for source preparation
and uses a D1 lease so cleanup and retries cannot process it concurrently.
`PUT /api/ciphers/share` applies the same transfer to a selected group of
personal ciphers. As with Vaultwarden, a failed item can leave earlier items
from the request already shared.
`POST /api/ciphers/import-organization?organizationId=...` accepts encrypted
ciphers, collections, and collection relationships for an owner or admin with
full collection access. Existing collection IDs are reused. Each request is
bounded to 100 ciphers and 100 collections. A D1 import record lets the
scheduled handler finish an interrupted publish after cipher data is staged in
the organization Durable Object. Organization and account deletion first settle
pending transfers and imports.
Organization metadata and public-key reads, owner edits, and global collection
listing are available for client administration screens. Owners and admins with
full collection access can export encrypted organization collections and ciphers.
Owners and admins can rename collections and delete empty ones. Only an owner
can delete an organization, with a master-password check. Deletion marks the
organization in D1, fences and clears its Durable Object, then removes D1 rows;
the scheduled handler retries interrupted cleanup.
An owner or admin can invite a member, then confirm the accepted membership
using the client-wrapped organization key. Pending members have no vault
access. Confirmed members see only assigned collections; removal revokes access
on the next request. Set `ORG_INVITATION_EMAILS_ENABLED=true` to send signed
seven-day invite links through the native Cloudflare Email Service binding.
Set `APP_URL` to the canonical HTTPS vault origin and `EMAIL_FROM` to a verified
sender before enabling it. This switch is off by default. The link opens the bundled web vault's
acceptance screen. An unregistered invitee may create an account with the
signed token even while public registration is disabled. The invited email is
then marked verified; the invitee accepts before the owner can confirm the
organization key. Failed delivery leaves the invitation pending so an owner
can resend it. With mail disabled, an already registered account with a public
key may still be added as an accepted member for owner confirmation. Regular
members have read-only shared item access. Owners and admins can view member details
and change a regular member's collection assignments. Removing an assignment
immediately blocks shared cipher and attachment reads through that collection.
Set `ORG_CREATION_USERS` to a comma-separated list of account emails to restrict
who can create organizations. An owner cannot delete their account while they
are the only active owner of an organization.

Optional SCIM directory sync runs on the five-minute scheduled handler when
`SCIM_DIRECTORY_URL`, `SCIM_TOKEN`, and `SCIM_ORGANIZATION_ID` are configured.
The source must be HTTPS and return complete, version-consistent SCIM `/Users`
pages with `urn:thecomputerplumbers:scim:directoryVersion`. The Worker validates
every page before changing memberships. It tracks directory identities in D1
and revokes only memberships created by this sync when an identity disappears,
is disabled, or changes email. It never revokes an owner. Set
`SCIM_INVITATIONS_ENABLED=true` to create pending memberships for directory
users. When `ORG_INVITATION_EMAILS_ENABLED=true` is also set, the sync creates
account stubs for unregistered users, sends signed invitation links, and
retries failed delivery. The recipient accepts before an owner confirms the
client-wrapped organization key. With email sending disabled, only accounts
that already have a public key become pending members, and those members are
ready for owner confirmation. SCIM group-to-collection mapping is not yet implemented; new members start
without collection access until an owner assigns collections. Configure the URL, token, and organization ID as
Worker secrets in the intended environment. The token is sent only to the
configured HTTPS source, with redirects disabled.

Authenticated account deletion requires the master-password hash. It marks the
account as deleting in D1, which immediately blocks login and existing sessions,
then clears the account's Durable Object and removes attachment and Send objects
from R2. D1 removes the account last. A five-minute scheduled handler retries
interrupted cleanup. The vault object retains a deletion fence so an in-flight
request cannot repopulate it after cleanup.

This is an initial protocol implementation. Current clients may need routes or
response fields beyond the ones listed above. Other
two-factor providers and remembered
devices, account recovery, and notifications still need
implementation. A browser flow has been tested, but mobile and desktop clients
have not been tested, so this cannot yet replace Vaultwarden.

The local smoke test runs against a real Wrangler Worker with disposable D1
and Durable Object state. It checks registration, prelogin, password login,
token rotation, encrypted item and folder sync, attachment upload/download,
TOTP enrollment and login, recovery, password changes, text and file Send access,
account deletion, and account isolation. Run
`pnpm test:worker` after a build or changes to authentication and vault data.

A disposable Bitwarden CLI 2026.2.0 account was exercised against the current
Worker over local HTTPS. Password login, sync, encrypted item creation,
attachment upload, normal sync after upload, and encrypted attachment download
succeeded; the downloaded bytes matched the source. Attachment completion and
deletion advance the cipher revision so clients see changes on their next sync.
Generated download links use the canonical `APP_URL` origin. An earlier CLI run
also covered item editing, folders, trash, and restore. These checks do not
cover every client or API route.
The same CLI version also accepted a newly issued personal API key over a
disposable local HTTPS Worker and retained a locked account session. API-key
login does not unlock a vault by itself; the test account used placeholder
encrypted keys, so this check did not exercise client-side decryption.

The account revision endpoint includes organization Durable Object revisions,
so edits to shared ciphers trigger a client sync even when the personal vault
has not changed.

The bundled Vaultwarden web vault 2026.7.0 was exercised in isolated Chrome
against a disposable HTTPS Wrangler Worker. Account creation, automatic sign-in,
loading the vault, creating an encrypted login item, and viewing it succeeded.
The client still requests `/api/auth-requests/pending`, which currently returns
404; device approval has not been implemented. The upstream bundle also links
to `/css/vaultwarden.css` without shipping that stylesheet; the main styles
load and the tested screens rendered.
