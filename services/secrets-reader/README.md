# cloudwarden secrets reader

Serves cloudwarden Secrets Manager secrets to [External Secrets Operator](https://external-secrets.io)
inside a Kubernetes cluster. It authenticates to cloudwarden with a machine
account's access token, decrypts in the pod, and answers ESO's webhook
provider. cloudwarden never sees a plaintext secret; this reader holds the
only key that opens them, and never logs a value, token, or key.

The contract it implements is [`docs/secrets-manager.md`](../../docs/secrets-manager.md).
It is a single Go binary using only the standard library.

## Configuration

| Variable                   | Required | Meaning                                                                                                                                     |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDWARDEN_URL`          | yes      | e.g. `https://vault.thecomputerplumbers.com`                                                                                                |
| `CLOUDWARDEN_ACCESS_TOKEN` | yes      | the `cw1.…` token from a machine account in the vault's Secrets screen                                                                      |
| `READER_TOKEN`             | yes      | a random string (16+ characters) callers must send as `Authorization: Bearer …`                                                             |
| `LISTEN_ADDR`              | no       | default `:8080`                                                                                                                             |
| `CACHE_TTL`                | no       | how long decrypted secrets are cached, default `60s`. If a refresh fails, the last good copy is served and `/healthz` reports `stale: true` |

## Routes

| Route                          | Returns                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `GET /v1/secrets/{key}`        | `{"value": "…"}` for the readable secret named `{key}`; 409 if two share it (add `?project=<projectId>`) |
| `GET /v1/secrets/by-id/{id}`   | `{"value": "…"}`                                                                                         |
| `GET /v1/projects/{projectId}` | `{"KEY": "value", …}` for every readable secret in the project                                           |
| `GET /healthz`                 | 200 once it has authenticated (no auth needed); the body describes the cache, never its contents         |

## Install

1. In the vault, open **Secrets** for the organization, create a machine
   account, grant it the projects it may read, and create an access token.
   Copy the `cw1.…` token; it is shown once.
2. Create the two Secrets. They are separate on purpose: ESO exposes every key
   of a Secret it references to its templates, so it only gets the reader
   token, and ESO requires the `external-secrets.io/type: webhook` label on it.

   ```sh
   kubectl create namespace cloudwarden
   kubectl -n cloudwarden create secret generic cloudwarden-secrets-reader \
     --from-literal=CLOUDWARDEN_ACCESS_TOKEN='cw1.…'
   kubectl -n cloudwarden create secret generic cloudwarden-secrets-reader-auth \
     --from-literal=READER_TOKEN="$(openssl rand -hex 32)"
   kubectl -n cloudwarden label secret cloudwarden-secrets-reader-auth external-secrets.io/type=webhook
   ```

3. Install the chart, with the stores ESO uses:

   ```sh
   helm install cloudwarden-secrets ./chart -n cloudwarden --set secretStore.enabled=true
   ```

   The NetworkPolicy admits only the namespace labelled
   `kubernetes.io/metadata.name: external-secrets`; change
   `networkPolicy.esoNamespaceLabels` if ESO runs elsewhere.

Build the image from this directory with `docker build -t cloudwarden-secrets-reader .`
(a static binary on `distroless/static:nonroot`).

## Using it from ExternalSecrets

One secret by key, through the `cloudwarden` store:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: app-database
spec:
  refreshInterval: 5m
  secretStoreRef:
    kind: ClusterSecretStore
    name: cloudwarden
  target:
    name: app-database
  data:
    - secretKey: DATABASE_URL
      remoteRef:
        key: DATABASE_URL
```

Every secret in a project, through the `cloudwarden-projects` store (its URL is
`/v1/projects/{{ .remoteRef.key }}` and its result is the whole JSON object):

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: app-env
spec:
  refreshInterval: 5m
  secretStoreRef:
    kind: ClusterSecretStore
    name: cloudwarden-projects
  target:
    name: app-env
  dataFrom:
    - extract:
        key: <projectId>
```

## Development

```sh
go vet ./... && go test -race ./...          # from this directory
node testdata/gen-vectors.mjs                 # regenerate the JavaScript-made test vectors
pnpm test:reader                              # from the repository root
SECRETS_READER_BIN=/path/to/secrets-reader pnpm test:secrets   # end to end against a local cloudwarden
```
