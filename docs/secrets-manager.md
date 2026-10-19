# Secrets Manager

Cloudwarden's own secrets manager for machines: projects of secrets inside an
organization, machine accounts with per-project access, and access tokens that
an in-cluster reader uses to feed Kubernetes through External Secrets Operator.

It is not Bitwarden Secrets Manager. Bitwarden's SM clients (the `bws` CLI, the
SDKs, ESO's `bitwardensecretsmanager` provider) are licensed only for use with
Bitwarden's own servers, so cloudwarden ships all three parts itself:

| Part                   | Where                                                                       | Language                    |
| ---------------------- | --------------------------------------------------------------------------- | --------------------------- |
| Server API and storage | `apps/web/worker/secrets-manager.ts`, `apps/web/db/schema/secrets.ts`       | TypeScript (Worker, D1)     |
| Management screens     | `apps/web/vault/ui/secrets/`, crypto in `apps/web/vault/crypto/secrets.ts`  | TypeScript (React, browser) |
| In-cluster reader      | `services/secrets-reader/` (Helm chart in `services/secrets-reader/chart/`) | Go                          |

Like the vault, it is end-to-end encrypted: the server stores only ciphertext
and hashes, and can read none of it.

## Crypto

Encrypted strings are Bitwarden's type 2 format, `2.<iv>|<data>|<mac>` (each
part base64): AES-256-CBC with PKCS#7 padding, then HMAC-SHA256 over `iv || data`
with the MAC half of the key. A 64-byte symmetric key is 32 bytes of AES key
followed by 32 bytes of MAC key. The MAC is checked, in constant time, before
anything is decrypted.

### What is encrypted with what

| Value                              | Encrypted with        |
| ---------------------------------- | --------------------- |
| project name                       | the organization key  |
| secret key (its name), value, note | the organization key  |
| machine account name               | the organization key  |
| access token name                  | the organization key  |
| access token payload               | the token key (below) |

The organization key is the organization's existing 64-byte symmetric key,
which every member already holds (wrapped with their RSA public key).

### Access tokens

A token is created entirely in the browser of an organization admin:

1. `tokenId`: a random UUID v4.
2. `clientSecret`: 32 random bytes, base64url without padding.
3. `keyMaterial`: 16 random bytes.
4. The **token key** (64 bytes) is HKDF-SHA256 with
   `ikm = keyMaterial`, `salt = UTF-8 "cloudwarden-sm-access-token"`,
   `info = UTF-8 "sm-access-token-key"`, length 64.
5. The **payload** is the JSON
   `{"organizationId":"<id>","organizationKey":"<base64 of the 64-byte org key>"}`,
   UTF-8 encoded and encrypted as a type 2 string with the token key.
6. The browser sends the server `tokenId`, the encrypted name, `secretHash`
   (lowercase hex SHA-256 of the UTF-8 `clientSecret`), the payload, and an
   optional expiry. `clientSecret` and `keyMaterial` never reach the server.
7. The admin is shown the token once:

   ```
   cw1.<tokenId>.<clientSecret>.<keyMaterial as base64url, no padding>
   ```

The reader authenticates with `tokenId` and `clientSecret`, receives the
payload, derives the token key from `keyMaterial`, decrypts the organization
key, and decrypts the secrets it is allowed to read. Revoking the token on the
server stops it from authenticating; anyone who saw a token and the ciphertext
could still decrypt that ciphertext, so a leaked token also calls for rotating
the secrets it could read, as with any secrets manager.

## Server API

All routes are under `/api/cloudwarden/sm/`, return JSON with
`Cache-Control: no-store`, and report errors as `{ "error": "<message>" }`.

### Admin routes (vault session)

`Authorization: Bearer <vault access token>` (the same session the vault uses).
The caller must be a confirmed owner or admin (role 0 or 1) of the
organization. IDs are UUIDs; every encrypted field is a type 2 string of at most
100,000 characters.

| Method | Path                                                  | Body                                                    | Returns                                          |
| ------ | ----------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| GET    | `orgs/{orgId}`                                        |                                                         | `{ projects, secrets, machineAccounts }` (below) |
| POST   | `orgs/{orgId}/projects`                               | `{ id, name }`                                          | the project                                      |
| PUT    | `orgs/{orgId}/projects/{id}`                          | `{ name }`                                              | the project                                      |
| DELETE | `orgs/{orgId}/projects/{id}`                          |                                                         | 204; 409 if it still has secrets                 |
| POST   | `orgs/{orgId}/secrets`                                | `{ id, projectId, key, value, note }`                   | the secret                                       |
| PUT    | `orgs/{orgId}/secrets/{id}`                           | `{ projectId, key, value, note }`                       | the secret                                       |
| DELETE | `orgs/{orgId}/secrets/{id}`                           |                                                         | 204                                              |
| POST   | `orgs/{orgId}/machine-accounts`                       | `{ id, name }`                                          | the machine account                              |
| PUT    | `orgs/{orgId}/machine-accounts/{id}`                  | `{ name }`                                              | the machine account                              |
| DELETE | `orgs/{orgId}/machine-accounts/{id}`                  |                                                         | 204 (its access and tokens go too)               |
| PUT    | `orgs/{orgId}/machine-accounts/{id}/access`           | `{ grants: [{ projectId, write }] }`                    | the machine account                              |
| POST   | `orgs/{orgId}/machine-accounts/{id}/tokens`           | `{ id, name, secretHash, encryptedPayload, expiresAt }` | the token (no secrets)                           |
| DELETE | `orgs/{orgId}/machine-accounts/{id}/tokens/{tokenId}` |                                                         | 204                                              |

`id` in a POST is chosen by the client (a UUID v4), so a retried create is not
a second object. `note` and `expiresAt` may be null; `expiresAt` is an ISO 8601
time in the future.

Shapes:

```ts
type Project = { id; organizationId; name; creationDate; revisionDate }
type Secret = {
  id
  organizationId
  projectId
  key
  value
  note
  creationDate
  revisionDate
}
type MachineAccount = {
  id
  organizationId
  name
  creationDate
  revisionDate
  access: { projectId; write: boolean }[]
  tokens: {
    id
    name
    expiresAt: string | null
    lastUsedDate: string | null
    creationDate
  }[]
}
```

### Machine routes (access token)

| Method | Path                   | Auth                             | Returns                                                                      |
| ------ | ---------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| POST   | `auth`                 | body `{ tokenId, clientSecret }` | `{ accessToken, expiresIn, organizationId, encryptedPayload }`               |
| GET    | `machine/projects`     | `Bearer <accessToken>`           | `{ data: Project[] }` the account can read                                   |
| GET    | `machine/secrets`      | `Bearer <accessToken>`           | `{ data: Secret[] }` in projects the account can read; `?projectId=` narrows |
| GET    | `machine/secrets/{id}` | `Bearer <accessToken>`           | the secret, or 404 if not readable                                           |

`auth` is rate limited per token and per client IP (20 a minute), fails with
401 for an unknown, revoked, or expired token or a wrong secret, and records
the token's last use. `accessToken` is valid for `expiresIn` seconds (600);
readers re-authenticate when it expires. Access is checked on every request,
so revoking a token or a grant takes effect within one access token lifetime
at most, and immediately for new authentications.

## In-cluster reader

`services/secrets-reader` is a single Go binary with no dependencies outside
the standard library. It reads `CLOUDWARDEN_URL` and `CLOUDWARDEN_ACCESS_TOKEN`
(from a Kubernetes Secret), authenticates, caches decrypted secrets for
`CACHE_TTL` (default 60s), and serves External Secrets Operator's webhook
provider on the cluster network:

| Method | Path                       | Returns                                                                                                                                   |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/secrets/{key}`        | `{ "value": "..." }` for the secret whose decrypted key is `{key}` (409 if two readable secrets share it); `?project=<projectId>` narrows |
| GET    | `/v1/secrets/by-id/{id}`   | `{ "value": "..." }`                                                                                                                      |
| GET    | `/v1/projects/{projectId}` | `{ "<key>": "<value>", ... }` for `dataFrom`                                                                                              |
| GET    | `/healthz`                 | 200 once it has authenticated                                                                                                             |

Callers authenticate with `Authorization: Bearer <READER_TOKEN>`, a random
token the ESO store sends. It lives in its own Kubernetes Secret, apart from
`CLOUDWARDEN_ACCESS_TOKEN`: ESO exposes every key of a Secret it references to
its templates (as `.<name>.<key>`), and it only reads Secrets labelled
`external-secrets.io/type: webhook`. The chart also ships a NetworkPolicy that
admits only the External Secrets Operator namespace. See
`services/secrets-reader/README.md` for installing it.

Example `ClusterSecretStore` (the chart renders this, and a second store,
`cloudwarden-projects`, whose URL is `/v1/projects/{{ .remoteRef.key }}` and
whose `jsonPath` is `$`, for `dataFrom`):

```yaml
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: cloudwarden
spec:
  provider:
    webhook:
      url: "http://cloudwarden-secrets.cloudwarden.svc/v1/secrets/{{ .remoteRef.key }}"
      result:
        jsonPath: "$.value"
      headers:
        Authorization: "Bearer {{ print .auth.READER_TOKEN }}"
      secrets:
        - name: auth
          secretRef:
            name: cloudwarden-secrets-reader-auth
            namespace: cloudwarden
```
