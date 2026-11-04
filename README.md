# Notification Dispatcher

HTTP service that sends notification email over SMTP. Callers post a JSON payload (recipients, subject, body,
optional attachments) and get back a JSON result with one entry per delivery batch.

- Node.js 20.12 or newer (the container runs Node 24), ES modules, Express 4, Zod 4
- SMTP delivery with its own small client (no shell, no `mailx`): STARTTLS, optional login, batching, size checks
- Callers authenticate with the token in their `Authorization` header

## Contents

1. [Quick start](#quick-start)
2. [API](#api)
3. [Samples](#samples)
4. [Delivery rules](#delivery-rules)
5. [Configuration](#configuration)
6. [Deployment](#deployment)
7. [Tests](#tests)
8. [Troubleshooting](#troubleshooting)
9. [Project layout](#project-layout)

## Quick start

```bash
cp .env.example .env        # then edit .env: at least SMTP_HOST and SMTP_PORT
npm install
npm start                   # node server.mjs   (npm run dev restarts on file changes)
```

The server logs `server.started` and listens on `PORT` (default **3042**). Check it:

```bash
curl http://localhost:3042/health
# {"status":"ok"}
```

On a developer machine the `.env` file wins over variables already set in the shell or Windows. Inside a
Kubernetes/OpenShift pod the platform's environment variables win, and a `.env` file is not needed.

## API

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/send-email/v3` | Send an email (current route) |
| POST | `/send-email/v2`, `/send-email/v1` | Same behaviour, kept for older callers |
| POST | `/send-mail/v2`, `/send-mailx` | Same behaviour, kept for earlier callers |
| GET | `/health` (also `/healthz`) | Liveness and readiness probe, no authentication |

All send routes accept and return the same JSON. The `apiEndpoint` field in the response shows which route was called.

### Authentication

Send the caller's token in the `Authorization` header (in Postman: the Authorization tab).

```
Authorization: Bearer <token>
```

The header value is forwarded unchanged to `AUTH_URL` (`GET`, default
`https://devops-apis.nam.nsroot.net/activeDirectory/authorize`). The request is accepted only when that service
answers `200` with `authenticated` and a `principal`. Anything else returns `401` with:

```
Authorization failed. Please check your credentials or token.
```

If the authorization service cannot be reached, or answers with a server error, the API returns `503`.

### Request

`POST /send-email/v3`, `Content-Type: application/json`

| Field | Type | Required | Notes |
|---|---|---|---|
| `sender` | string | no | Valid email address. Falls back to `NOTIFICATION_SENDER` when omitted. |
| `receiver` | string or string[] | yes* | One or more addresses separated by `,` or `;`. (`to` is accepted as an alias.) |
| `receiverName` | string | no | Accepted and ignored. |
| `cc` | string or string[] | no | Same format as `receiver`. |
| `bcc` | string or string[] | no | Same format as `receiver`. Never appears in message headers. |
| `subject` | string | no | Up to 512 characters, no line breaks. Default: `Orion Notification email`. |
| `emailMessage` | string | no | Message body. (`body` is accepted as an alias.) Default: `This is auto-generated email from Orion as acknowledgement for your order placed there.` |
| `isHtml` | boolean | no | `true` sends `emailMessage` as HTML. Default `false`. The strings `"true"`/`"false"` are accepted. |
| `attachedFiles` | array | no | Up to 10 files, see below. |

\* At least one valid recipient is required across `receiver`, `cc` and `bcc`.

Each entry of `attachedFiles`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `filename` | string | yes | Shown to the recipient. Folder parts are dropped. |
| `encoding` | string | no | Only `base64` is supported (also the default). |
| `content` | string | yes | The file as plain base64 text. No `data:...;base64,` prefix. Line breaks are tolerated. |

An address that appears more than once (in any field, any letter case) is sent once. It keeps the first role it was
given: `receiver`, then `cc`, then `bcc`.

### Response

Every response, success or failure, uses the same fields:

| Field | Type | Meaning |
|---|---|---|
| `apiEndpoint` | string | The route that was called. |
| `emailSender` | string | Sender from the request, or the default sender. |
| `emailReceiver` | string | `receiver` as sent. |
| `emailCC` | string | `cc` as sent. |
| `emailBCC` | string | `bcc` as sent. |
| `emailSubject` | string | The subject used (the default when none was sent). |
| `emailInHtml` | boolean | Whether the body was sent as HTML. |
| `emailSendResponse` | string | Human-readable result or error, with a size breakdown on sends. |
| `emailSuccess` | boolean | `true` only when every batch was delivered and no recipient was refused. |
| `batchResults` | array | One entry per delivery batch. Present only once sending was attempted. |

Each `batchResults` entry has the same fields as above, filled with the recipients of that batch only.

The size breakdown inside `emailSendResponse` reads
`[Payload Breakdown: Body: 0.00MB, Attachments: 3.75MB, Total Message MIME: 5.14MB]`: the body, the attachment files
before encoding, and the largest encoded message.

### Status codes

| Status | When |
|---|---|
| `200` | Every batch was delivered. |
| `400` | Empty body, invalid sender or recipient, invalid base64, bad attachment name, subject with line breaks, malformed JSON. |
| `401` | Missing, invalid or unauthenticated token. |
| `413` | Attachments or the whole message are too large (see [Delivery rules](#delivery-rules)). Checked before SMTP is contacted. |
| `500` | One or more batches failed, or the mail server refused one or more recipients. `batchResults` shows which. |
| `503` | The authorization service is unavailable. |

## Samples

### Request with an attachment

```http
POST /send-email/v3
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "sender": "noreply@citi.com",
  "receiver": "user@example.com",
  "receiverName": "Paresh",
  "cc": "manager@example.com",
  "bcc": "",
  "subject": "Your request has been approved",
  "emailMessage": "Your Orion self-service request has been approved.",
  "isHtml": false,
  "attachedFiles": [
    {
      "filename": "report.pdf",
      "encoding": "base64",
      "content": "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoK..."
    }
  ]
}
```

### Success (`200`)

```json
{
  "apiEndpoint": "/send-email/v3",
  "emailSender": "noreply@citi.com",
  "emailReceiver": "user@example.com",
  "emailCC": "manager@example.com",
  "emailBCC": "",
  "emailSubject": "Your request has been approved",
  "emailInHtml": false,
  "emailSendResponse": "All email batches processed successfully. [Payload Breakdown: Body: 0.00MB, Attachments: 3.75MB, Total Message MIME: 5.14MB]",
  "emailSuccess": true,
  "batchResults": [
    {
      "apiEndpoint": "/send-email/v3",
      "emailSender": "noreply@citi.com",
      "emailReceiver": "user@example.com",
      "emailCC": "manager@example.com",
      "emailBCC": "",
      "emailSubject": "Your request has been approved",
      "emailInHtml": false,
      "emailSendResponse": "Email batch sent successfully. [Payload Breakdown: Body: 0.00MB, Attachments: 3.75MB, Total Message MIME: 5.14MB]",
      "emailSuccess": true
    }
  ]
}
```

### HTML body

```json
{
  "sender": "noreply@citi.com",
  "receiver": "user@example.com",
  "subject": "Order completed",
  "emailMessage": "<h2>Your order completed successfully.</h2><p>Please log in to the <i>cluster</i> and verify the \"project\" resources.</p>",
  "isHtml": true
}
```

### Many recipients (batching)

With 250 addresses in `bcc` and `receiver` set to one address, the service sends three messages (100, 100 and 51
recipients) and `batchResults` has three entries. In the later messages the `To` header reads
`undisclosed-recipients:;` and no recipient can see another.

### Partial failure (`500`)

When one batch fails, the others are still delivered and the response says which one failed:

```json
{
  "apiEndpoint": "/send-email/v3",
  "emailSender": "noreply@citi.com",
  "emailReceiver": "user@example.com",
  "emailCC": "",
  "emailBCC": "a@example.com,b@example.com,...",
  "emailSubject": "Notice",
  "emailInHtml": false,
  "emailSendResponse": "Some email batches failed (1 of 3). Batch 2: SMTP 552: mailbox full [Payload Breakdown: Body: 0.00MB, Attachments: 0.00MB, Total Message MIME: 0.00MB]",
  "emailSuccess": false,
  "batchResults": [
    { "emailSuccess": true,  "emailSendResponse": "Email batch sent successfully. [Payload Breakdown: ...]", "...": "..." },
    { "emailSuccess": false, "emailSendResponse": "Email batch failed: SMTP 552: mailbox full [Payload Breakdown: ...]", "...": "..." },
    { "emailSuccess": true,  "emailSendResponse": "Email batch sent successfully. [Payload Breakdown: ...]", "...": "..." }
  ]
}
```

### Errors (`4xx`, `503`)

Error responses have the same fields and never include `batchResults`.

Unauthorized (`401`):

```json
{
  "apiEndpoint": "/send-email/v3",
  "emailSender": "noreply@citi.com",
  "emailReceiver": "user@example.com",
  "emailCC": "",
  "emailBCC": "",
  "emailSubject": "Notice",
  "emailInHtml": false,
  "emailSendResponse": "Authorization failed. Please check your credentials or token.",
  "emailSuccess": false
}
```

Other `emailSendResponse` texts you may see:

| Status | Text |
|---|---|
| 400 | `Data not found to send email.` |
| 400 | `Sender email address is not valid` |
| 400 | `Receiver email address is not valid` (also `CC email address is not valid`, `BCC email address is not valid`) |
| 400 | `Attachment "report.pdf" is not valid base64.` |
| 400 | `At most 10 attachments are allowed.` |
| 400 | `Request body is not valid JSON.` |
| 413 | `The attachments are too large: 16.0 MB in total, but the limit is 15.0 MB.` |
| 413 | `The message is too large: about 25.1 MB once encoded, but the limit for one message is 24.0 MB (roughly 15.0 MB of attachments).` |
| 413 | `Request body is too large.` |
| 503 | `The authorization service is unavailable. Please try again later.` |

### Calling it

curl:

```bash
curl -X POST http://localhost:3042/send-email/v3 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"sender":"noreply@citi.com","receiver":"user@example.com","subject":"Test","emailMessage":"Hello"}'
```

Postman: method `POST`, Authorization tab set to the token type you use, Body set to `raw` and `JSON`.

Convert a file to base64 for `content`:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\report.pdf")) | Set-Clipboard
```

```bash
base64 -w0 report.pdf
```

## Delivery rules

| Rule | Value | Setting |
|---|---|---|
| Recipients per message | up to 100 (`receiver` + `cc` + `bcc` together) | `MAIL_BATCH_SIZE` |
| Recipients per message when the message is 5 MiB or larger | up to 20 | `MAIL_LARGE_MESSAGE_BYTES`, `MAIL_LARGE_MESSAGE_MAX_RECIPIENTS` |
| Attachments per email | 10 | `MAIL_MAX_ATTACHMENTS` |
| Attachment files, total, before encoding | 15 MiB | `MAIL_MAX_ATTACHMENT_BYTES` |
| One message after base64 encoding (body, headers, attachments) | 24 MiB | `MAIL_MAX_MESSAGE_BYTES` |
| JSON request size | 30 MB | `MAIL_BODY_LIMIT` |

- Base64 makes files about 37% larger, so 15 MiB of files becomes about 20.5 MiB in the message.
- Sizes are checked from the text length before anything is decoded, and before SMTP is contacted, so an oversized request fails fast with a clear `413`.
- Batches are sent one after another. A failed batch does not stop the rest, unless the connection to the mail server itself failed. Batches not attempted then report `Skipped after a connection failure.`
- A recipient the mail server refuses makes `emailSuccess` false (status `500`), while the other recipients in that batch are still delivered.
- Subjects, names and body text are encoded safely, so quotes, `$`, backticks, line breaks and non-English characters are preserved. Line breaks in the subject or sender are rejected.

## Configuration

Settings come from environment variables. Copy `.env.example` to `.env` for local runs. Invalid values stop the server at
startup with a message naming the setting.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3042` | HTTP port. |
| `NODE_ENV` | `development` | Environment name (`development`, `uat`, `production`). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent`. |
| `AUTH_URL` | `https://devops-apis.nam.nsroot.net/activeDirectory/authorize` | Service that verifies the caller's token. |
| `AUTH_TIMEOUT_MS` | `5000` | How long to wait for that service. |
| `NOTIFICATION_SENDER` | none | Sender used when the request has none. |
| `SMTP_HOST` | **required** | Mail relay host. |
| `SMTP_PORT` | `25` | Mail relay port. |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (port 465). |
| `SMTP_STARTTLS` | `true` | Upgrade to TLS when the server offers it. Set `false` for plain SMTP. |
| `SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | `false` accepts any server certificate. |
| `SMTP_USER`, `SMTP_PASSWORD` | none | SMTP login. Leave both empty when the relay needs none; set both or neither. |
| `SMTP_TIMEOUT_MS` | `30000` | Socket timeout for the mail server. |
| `MAIL_BATCH_SIZE` | `100` | Recipients per message (1 to 300). |
| `MAIL_MAX_MESSAGE_BYTES` | `25165824` | Largest encoded message (24 MiB, at most 25 MiB). |
| `MAIL_MAX_ATTACHMENT_BYTES` | `15728640` | Largest total of attachment files (15 MiB). |
| `MAIL_MAX_ATTACHMENTS` | `10` | Attachments per email (1 to 20). |
| `MAIL_LARGE_MESSAGE_BYTES` | `5242880` | Messages at or above this size count as large (5 MiB). |
| `MAIL_LARGE_MESSAGE_MAX_RECIPIENTS` | `20` | Recipients per large message (1 to 300). |
| `MAIL_BODY_LIMIT` | `30mb` | Largest JSON request. Keep it above `MAIL_MAX_MESSAGE_BYTES`. |

Empty values count as not set. Wrap a value in double quotes in `.env` if it contains `#` or spaces.

## Deployment

The image is built from the `Dockerfile` and started with `npm start`. The Helm chart lives in `helm/main`:

- `templates/configmap.yaml` holds every setting above (filled from the `config:` block of each values file) and the
  deployment loads it with `envFrom`. A checksum annotation restarts the pods when the config changes.
- No Secret is needed: callers send their own token and the mail relay needs no login. Never put credentials in values
  files, `.env` or the image.
- The liveness and readiness probes call `GET /health` on port 3042.
- `SMTP_HOST` is required in every values file. A missing one fails `helm template` instead of deploying a crashing pod.
- The pod needs network access to the mail relay on `SMTP_PORT` and to the host in `AUTH_URL`.

Check a chart before committing:

```bash
helm lint helm/main -f helm/main/dev-values.yaml
helm template notification-dispatcher helm/main -f helm/main/dev-values.yaml
```

After a deploy: the pod is Ready, the log shows `server.started`, `GET /health` returns `{"status":"ok"}`, and a
request with a real token returns `200`.

## Tests

```bash
npm test
```

One test file (`tests/mail.test.mjs`, 11 tests) runs the real server against an in-process fake SMTP server and a fake
authorization service. It covers the request and response shape, HTML and special characters, batching (including the
large-message rule), attachments byte for byte, size limits, validation errors, a failed batch, authorization
(accepted, rejected, unexpected answers, service down), and the earlier routes.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `401` on every call | Check the `auth.denied` log line: `no Authorization header`, `rejected with 401`, or `token is not authenticated`. Send a valid token in the `Authorization` header. |
| `503` | The authorization service could not be reached. Check `AUTH_URL` and network access from where the service runs. |
| `500` with `connect EACCES host:25` | The operating system or firewall blocks outbound port 25 (common on workstations). Run the service where the relay is reachable, or use a permitted port. |
| `500` with `ECONNREFUSED` or a timeout | `SMTP_HOST` or `SMTP_PORT` is wrong, or the relay is not reachable from here. |
| `500` with `Must issue a STARTTLS command first` | Set `SMTP_STARTTLS=true`. |
| `413` | The attachments or message exceed the limits in [Delivery rules](#delivery-rules). The message says how much fits. |
| Server exits with `Invalid configuration: ...` | The named setting is missing or invalid, usually `SMTP_HOST`. |
| `.env` changes seem ignored | Restart the server. In a pod, platform variables win over `.env`. |
| `env.overridden` warning in the log | On a developer machine, `.env` replaced values already set in your shell or Windows environment. |

## Project layout

```
server.mjs                 starts the server, loads .env, handles shutdown
app.mjs                    builds the Express app (routes, health check, error handling)
config.mjs                 reads and validates environment variables
logger.mjs                 JSON log lines
errors.mjs                 error type carrying an HTTP status
routes/mailRoutes.mjs      the send routes
middleware/authorize.mjs   token check against AUTH_URL
controllers/mailx.mjs      request validation, defaults, response building
controllers/response.mjs   the shared response shape
services/recipients.mjs    splitting, validating, de-duplicating and batching recipients
services/attachments.mjs   base64 validation and size limits
services/mime.mjs          builds the email message
services/smtp.mjs          SMTP client (STARTTLS, optional login, size and recipient handling)
services/mailer.mjs        runs the batches and collects the results
tests/mail.test.mjs        the test suite
helm/main/                 Helm chart and per-environment values
```
