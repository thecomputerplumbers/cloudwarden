# Copy the Projects feature

Projects is a small complete vertical feature, backed by D1. Members can read;
admins and owners can create, edit and archive. Every query includes the authorized
organization. IDs belonging to another organization return not found. Writes
recheck membership and grant validity in the SQL statement itself.

| Concern                                   | Start here                                                           |
| ----------------------------------------- | -------------------------------------------------------------------- |
| Table, index, migration                   | `apps/web/db/schema/projects.ts`, `drizzle.config.ts`, `migrations/` |
| Validation, authorization, persistence    | `apps/web/operations/projects.ts`                                    |
| Browser API                               | `apps/web/app/api/projects/route.ts`                                 |
| List, cursor pagination, detail and forms | `apps/web/app/projects/`                                             |
| Scoped MCP tools                          | `apps/web/mcp/handler.ts`                                            |
| OAuth scope declarations                  | `packages/auth/src/grants.ts`, `auth.ts`                             |
| Real Worker coverage                      | `tests/worker-smoke.mjs`                                             |
| Local fixtures                            | `scripts/local-data.mjs`                                             |

Copy those pieces and rename the resource. Add a schema module individually to
the Drizzle config and runtime barrel, then `pnpm db:generate`. Reuse the operation
context and error mapping; avoid duplicating business rules in tools or routes.

The client supplies a UUID on create. Repeating that ID with identical data is
safe; conflicting data fails. Updates carry the last-read integer version and
atomically increment it. An outdated form receives CONFLICT rather than overwriting
someone else's edit. Archiving uses the same update operation; there is no hard
delete. Pagination uses a stable indexed UUID cursor with a bounded page size.

## Errors and diagnostics

`AppError` carries a stable code, safe message and optional field errors.
Browser routes use `errorResponse`; forms show validation beside the field.
MCP tools use the same public shape with `isError: true`. Unexpected exception
messages never reach clients. A response's `X-Request-ID` correlates its structured
Worker logs; operation errors also include the ID in their response body.

`logEvent` accepts an allowlist of status, duration, operation and error code.
Never pass tokens, cookies, payloads, raw URLs or arbitrary error objects. The
request wrapper logs a completion for each handled request and preserves streaming
bodies. Cloudflare and Better Auth may emit their own runtime logs; configure their
retention/access separately. Loading, not-found and recoverable error UI live at
the app root. Product configuration supplies the support address.

Run `mise run check` and `pnpm test:worker` after copying or changing the feature.
The latter checks browser/MCP writes, retries, pagination, stale-edit conflicts,
field errors, role restrictions, and cross-organization isolation.
