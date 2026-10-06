# @workspace/email

Transactional mail through Cloudflare Email Service's native `send_email`
Worker binding. No HTTP vendor adapter or API-key SDK is needed.

`createMailer(env.EMAIL, from)` sends plain text and escaped HTML. The app owns
verification, password-reset and invitation wording in `apps/web/lib/auth.ts`.
Delivery is awaited so failures are visible rather than silently discarded.

## Local development

Copy `apps/web/.dev.vars.example` to `apps/web/.dev.vars`, apply local D1
migrations and run `mise run dev`. Wrangler simulates the EMAIL binding and
prints the message's text/HTML file paths. Open the text file for the local
verification or reset link. No email leaves your computer. Do not enable
`remote: true` for development or tests.

## Deployment

Enable Cloudflare Email Service for the deployment's account and configure a
verified sending domain. Set `EMAIL_FROM` to an allowed sender on that domain
and `APP_URL` to the app's canonical HTTPS origin (without a trailing slash).
Keep the `send_email` binding named `EMAIL` in `wrangler.jsonc`; use separate
sender configuration for each product/environment. The app refuses an absent
sender outside localhost. `cloudwarden@example.com` is only a local simulation default.

See the [Cloudflare Workers sending API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
and [local development](https://developers.cloudflare.com/email-service/local-development/sending/).
Email Routing alone is not the outbound transactional-email setup.
