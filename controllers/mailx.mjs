import { z } from 'zod';
import { AppError } from '../errors.mjs';
import { isAddress } from '../services/recipients.mjs';
import { mailResponse } from './response.mjs';

const DEFAULT_SUBJECT = 'Orion Notification email';
const DEFAULT_MESSAGE = 'This is auto-generated email from Orion as acknowledgement for your order placed there.';

const list = z.union([z.string(), z.array(z.string())]).optional();
const noLineBreaks = (value) => !/[\r\n]/.test(value);

const requestSchema = z.object({
  sender: z.string().trim().optional(),
  receiver: list,
  to: list,
  receiverName: z.string().optional(),
  cc: list,
  bcc: list,
  subject: z
    .string()
    .max(512)
    .refine(noLineBreaks, 'must not contain line breaks')
    .optional()
    .transform((v) => v || DEFAULT_SUBJECT),
  emailMessage: z.string().optional(),
  body: z.string().optional(),
  isHtml: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .optional()
    .transform((v) => v ?? false),
  attachedFiles: z
    .array(
      z.object({
        filename: z.string().min(1),
        encoding: z.literal('base64').optional(),
        content: z.string().min(1),
      }),
    )
    .nullish()
    .transform((v) => v ?? []),
});

function parseRequest(body, config) {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');
    throw new AppError(400, `Invalid request: ${detail}`);
  }
  const input = parsed.data;
  const from = input.sender || config.NOTIFICATION_SENDER;
  if (!from || !isAddress(from)) throw new AppError(400, 'Sender email address is not valid');

  return {
    from,
    to: input.receiver ?? input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.emailMessage || input.body || DEFAULT_MESSAGE,
    isHtml: input.isHtml,
    attachedFiles: input.attachedFiles,
  };
}

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(2)}MB`;

export function createMailController({ config, mailer, logger }) {
  return {
    async send(req, res) {
      const endpoint = req.path;
      let echo = req.body;
      const respond = (status, message, success, batchResults) =>
        res.status(status).json(mailResponse(endpoint, echo, config, message, success, batchResults));

      try {
        if (!req.body || Object.keys(req.body).length === 0) throw new AppError(400, 'Data not found to send email.');
        const request = parseRequest(req.body, config);
        echo = { ...req.body, subject: request.subject };
        const outcome = await mailer.send(request);

        const breakdown =
          `[Payload Breakdown: Body: ${megabytes(outcome.bodyBytes)}, ` +
          `Attachments: ${megabytes(outcome.attachmentBytes)}, Total Message MIME: ${megabytes(outcome.mimeBytes)}]`;
        const failed = outcome.batches.filter((b) => !b.ok || b.rejected.length > 0);
        const ok = failed.length === 0;

        const batchResults = outcome.batches.map((batch) => {
          const batchOk = batch.ok && batch.rejected.length === 0;
          const detail = !batch.ok
            ? `Email batch failed: ${batch.reason}`
            : batch.rejected.length
              ? `Email batch sent, but ${batch.rejected.length} recipient(s) were rejected by the mail server (${batch.rejected
                  .slice(0, 5)
                  .map((r) => r.address)
                  .join(', ')}).`
              : 'Email batch sent successfully.';
          return mailResponse(
            endpoint,
            { ...echo, receiver: batch.to, cc: batch.cc, bcc: batch.bcc },
            config,
            `${detail} ${breakdown}`,
            batchOk,
          );
        });

        const message = ok
          ? `All email batches processed successfully. ${breakdown}`
          : `Some email batches failed (${failed.length} of ${outcome.batches.length}). ${failed
              .slice(0, 3)
              .map((b) => `Batch ${outcome.batches.indexOf(b) + 1}: ${b.reason || `${b.rejected.length} recipient(s) rejected`}`)
              .join(' | ')} ${breakdown}`;
        respond(ok ? 200 : 500, message, ok, batchResults);
      } catch (error) {
        if (error instanceof AppError) return respond(error.status, error.message, false);
        logger.error('mail.request.failed', { endpoint, error: error.message });
        respond(500, 'Unexpected error while sending the email.', false);
      }
    },
  };
}
