import { z } from 'zod';
import { AppError } from '../errors.mjs';
import { isAddress } from '../services/recipients.mjs';
import { mailResponse } from './response.mjs';

const list = z.union([z.string(), z.array(z.string())]).optional();
const noLineBreaks = (value) => !/[\r\n]/.test(value);

const requestSchema = z.object({
  sender: z.string().trim().optional(),
  receiver: list,
  to: list,
  cc: list,
  bcc: list,
  subject: z
    .string()
    .max(500)
    .refine(noLineBreaks, 'must not contain line breaks')
    .optional()
    .transform((v) => v || 'No Subject'),
  body: z.string().optional(),
  emailMessage: z.string().optional(),
  isHtml: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .optional()
    .transform((v) => v ?? false),
  attachments: z
    .array(z.union([z.string().min(1), z.object({ path: z.string().min(1) })]))
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
  if (!from) throw new AppError(400, 'No sender provided.');
  if (!isAddress(from)) throw new AppError(400, `Invalid sender address: ${from.slice(0, 80)}`);

  return {
    from,
    to: input.receiver ?? input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.body ?? input.emailMessage ?? '',
    isHtml: input.isHtml,
    attachments: input.attachments,
  };
}

function summarise(outcome) {
  if (outcome.failures.length === 0 && outcome.rejected.length === 0) {
    return { ok: true, message: outcome.total > 1 ? 'Email sent successfully in batches.' : 'Email sent successfully.' };
  }
  const details = [
    ...outcome.failures.slice(0, 3).map((f) => `Batch ${f.batch} of ${outcome.total}: ${f.reason}`),
    ...(outcome.rejected.length
      ? [
          `${outcome.rejected.length} recipient(s) rejected by the mail server (${outcome.rejected
            .slice(0, 5)
            .map((r) => r.address)
            .join(', ')})`,
        ]
      : []),
  ];
  return { ok: false, message: `Some emails failed to send. ${details.join(' | ')}` };
}

export function createMailController({ config, mailer, logger }) {
  return {
    async send(req, res) {
      const endpoint = req.path;
      try {
        const outcome = await mailer.send(parseRequest(req.body, config));
        const { ok, message } = summarise(outcome);
        res.status(ok ? 200 : 500).json(mailResponse(endpoint, req.body, message, ok));
      } catch (error) {
        if (error instanceof AppError) {
          return res.status(error.status).json(mailResponse(endpoint, req.body, error.message, false));
        }
        logger.error('mail.request.failed', { endpoint, error: error.message });
        res.status(500).json(mailResponse(endpoint, req.body, 'Unexpected error while sending the email.', false));
      }
    },
  };
}
