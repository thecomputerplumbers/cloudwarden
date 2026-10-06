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
even on localhost. Its static loading is verified locally, but signup and vault
use in a browser still need testing on a trusted HTTPS deployment.

Current routes cover server configuration, legacy account registration,
the web vault's start/finish registration flow with a short-lived signed token,
prelogin, password login, master password and PBKDF2 setting changes, rotating
refresh tokens, profile and asymmetric key updates, personal vault sync,
personal ciphers, folders, encrypted text and file Sends with public password
and access limits, and encrypted attachments stored in private R2. Send content
and access counters live in the owner's Durable Object; D1 maps public Send IDs
to that object. File Send uploads are currently capped at 20 MB. It also
supports authenticator app TOTP enrollment, login challenges,
single-use recovery codes, and disabling the factor. TOTP codes cannot be
replayed, and enrolling a factor revokes other sessions. Attachment links
expire after five minutes. Registration is disabled unless
`SIGNUPS_ALLOWED=true` is configured. Open registration currently has no email
verification, so enable it only for a controlled local environment. Access
tokens are signed JWTs that clients can decode, while refresh tokens are
opaque random values. Both are stored as SHA-256 hashes in D1 and checked
against the current session on every request. Access tokens expire after one
hour and refresh tokens after 30 days. Issuing tokens requires the
`BETTER_AUTH_SECRET` signing secret.

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
cannot transfer access. Moving personal ciphers into an
organization is not yet supported.
Organization metadata and public-key reads, owner edits, and global collection
listing are available for client administration screens.
Owners and admins can rename collections and delete empty ones. Only an owner
can delete an organization, with a master-password check. Deletion marks the
organization in D1, fences and clears its Durable Object, then removes D1 rows;
the scheduled handler retries interrupted cleanup.
An owner or admin can invite an already registered account with a public key,
then confirm the membership using the client-wrapped organization key. Pending
members have no vault access. Confirmed members see only assigned collections;
removal revokes access on the next request. The current invitation flow does not
send email, create accounts, or expose an acceptance screen, and regular members
have read-only shared item access. Owners and admins can view member details
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
users who have already registered a vault account with a public key. Pending
members still require owner confirmation with a client-wrapped organization
key. Unregistered identities remain pending in D1 and are considered again on
the next scheduled run after account creation. No invitation email is sent,
and SCIM group-to-collection mapping is not implemented; new members start
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
response fields beyond the ones listed above. Emailed invitations, other
two-factor providers and remembered
devices, account recovery, notifications, and import/export still need
implementation. Browser,
mobile, and desktop clients have not been tested, so this cannot yet replace
Vaultwarden.

The local smoke test runs against a real Wrangler Worker with disposable D1
and Durable Object state. It checks registration, prelogin, password login,
token rotation, encrypted item and folder sync, attachment upload/download,
TOTP enrollment and login, recovery, password changes, text and file Send access,
account deletion, and account isolation. Run
`pnpm test:worker` after a build or changes to authentication and vault data.

A disposable Bitwarden CLI 2026.2.0 account was also exercised against the
local Worker through a local HTTPS proxy. Password login, sync, encrypted item
creation and editing, folder creation, trash, and restore succeeded. This
checks a real client but does not cover every client or API route.
