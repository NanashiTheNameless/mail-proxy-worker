# Mail Proxy Worker

A small Cloudflare Worker that lets an app send email through an HTTP API.

Your app sends a `POST /send` request to this worker over HTTPS. The worker then connects to your SMTP provider and sends the email.

This is useful when your app runs somewhere that blocks outbound SMTP ports, or when you want one simple private endpoint for transactional email.

## What It Does

- Accepts email send requests over HTTPS.
- Requires a private API key before sending anything.
- Sends mail through your SMTP account.
- Supports `to`, `cc`, `bcc`, plain text, HTML, and reply-to addresses.
- Can optionally restrict recipients to one allowed domain.

## Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | `GET` | Checks that the worker is running. |
| `/send` | `POST` | Sends an email. |
| `/v1/send` | `POST` | Same as `/send`, with a versioned path. |
| `/smtp/send` | `POST` | Same as `/send`, with an SMTP-style path. |

## Authentication

Every send request must include your proxy API key.

Use either header:

```http
Authorization: Bearer YOUR_PROXY_API_KEY
```

or:

```http
x-proxy-key: YOUR_PROXY_API_KEY
```

The API key should be long, random, and stored as a Wrangler secret.

## Configuration

Edit `wrangler.toml` for non-secret settings:

```toml
MAIL_FROM = "No Reply <no-reply@example.com>"
MAIL_REPLY_TO = "support@example.com"
SMTP_HOST = "smtp.example.com"
SMTP_PORT = "587"
SMTP_SECURE = "false"
ALLOWED_TO_DOMAIN = ""
```

Config values:

| Name | Required | Description |
| --- | --- | --- |
| `MAIL_FROM` | Yes, unless each request has `from` | Default sender address. Supports `Name <email@example.com>`. |
| `MAIL_REPLY_TO` | No | Default reply-to address. |
| `SMTP_HOST` | Yes | SMTP server hostname. |
| `SMTP_PORT` | No | SMTP port. Defaults to `587`. |
| `SMTP_SECURE` | No | Use `false` for STARTTLS, usually port `587`. Use `true` for implicit TLS, usually port `465`. |
| `ALLOWED_TO_DOMAIN` | No | Restricts recipients to one domain, such as `example.com`. Leave empty to allow any domain. |

Store sensitive values as Wrangler secrets:

```bash
npx wrangler secret put PROXY_API_KEY
npx wrangler secret put SMTP_USER
npx wrangler secret put SMTP_PASS
```

Secret values:

| Name | Description |
| --- | --- |
| `PROXY_API_KEY` | Private key your app must send when calling this worker. |
| `SMTP_USER` | SMTP username. |
| `SMTP_PASS` | SMTP password or app password. |

## Install

```bash
npm install
```

## Local Development

For local development, create a `.dev.vars` file:

```bash
PROXY_API_KEY=replace-with-long-random-secret
SMTP_USER=no-reply@example.com
SMTP_PASS=replace-with-smtp-password
```

Then run:

```bash
npm run dev
```

Check that it is running:

```bash
curl http://localhost:8787/health
```

Expected response:

```json
{
  "ok": true,
  "service": "mail-proxy"
}
```

## Send An Email

```bash
curl -X POST http://localhost:8787/send \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": ["user@example.com"],
    "subject": "Hello",
    "text": "This is a test email."
  }'
```

Full request body:

```json
{
  "from": "No Reply <no-reply@example.com>",
  "to": ["user@example.com"],
  "cc": ["manager@example.com"],
  "bcc": ["audit@example.com"],
  "replyTo": "support@example.com",
  "subject": "Hello",
  "text": "Plain text body",
  "html": "<p>Optional HTML body</p>"
}
```

Request body rules:

- `to` is required.
- `subject` is required.
- At least one of `text` or `html` is required.
- `from` is optional if `MAIL_FROM` is configured.
- `replyTo` is optional if `MAIL_REPLY_TO` is configured.
- `to`, `cc`, and `bcc` may be arrays. `to` may also be a single email string.

Successful response:

```json
{
  "ok": true,
  "provider": "smtp",
  "result": {
    "accepted": 1
  }
}
```

## Deploy

Before deploying, make sure the secrets are set:

```bash
npx wrangler secret put PROXY_API_KEY
npx wrangler secret put SMTP_USER
npx wrangler secret put SMTP_PASS
```

Then deploy:

```bash
npm run deploy
```

After deployment, call your deployed worker URL or custom domain instead of `http://localhost:8787`.

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). See [LICENSE.md](LICENSE.md) for the full license text.
