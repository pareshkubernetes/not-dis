import { z } from 'zod';

const MiB = 1024 * 1024;

const flag = (fallback) =>
  z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v ?? fallback) === 'true');

const int = (fallback, min, max) => z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z
  .object({
    NODE_ENV: z.string().default('development'),
    PORT: int(3000, 1, 65535),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

    NOTIFICATION_EMAIL_USERNAME: z.string().optional(),
    NOTIFICATION_EMAIL_PASSWORD: z.string().optional(),
    NOTIFICATION_SENDER: z.email().optional(),

    SMTP_HOST: z.string().min(1),
    SMTP_PORT: int(25, 1, 65535),
    SMTP_SECURE: flag('false'),
    SMTP_STARTTLS: flag('true'),
    SMTP_TLS_REJECT_UNAUTHORIZED: flag('true'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_TIMEOUT_MS: int(30_000, 1_000, 300_000),

    MAIL_BATCH_SIZE: int(100, 1, 300),
    MAIL_MAX_MESSAGE_BYTES: int(20 * MiB, MiB, 25 * MiB),
    MAIL_MAX_ATTACHMENTS: int(10, 1, 20),
    // Attachments travel inside the JSON body as base64 (+33%), so this must exceed MAIL_MAX_MESSAGE_BYTES.
    MAIL_BODY_LIMIT: z.string().default('30mb'),
  })
  .refine((c) => Boolean(c.SMTP_USER) === Boolean(c.SMTP_PASSWORD), {
    message: 'SMTP_USER and SMTP_PASSWORD must be set together',
    path: ['SMTP_PASSWORD'],
  })
  .refine((c) => Boolean(c.NOTIFICATION_EMAIL_USERNAME) === Boolean(c.NOTIFICATION_EMAIL_PASSWORD), {
    message: 'NOTIFICATION_EMAIL_USERNAME and NOTIFICATION_EMAIL_PASSWORD must be set together',
    path: ['NOTIFICATION_EMAIL_PASSWORD'],
  });

export function loadConfig(env = process.env) {
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  return Object.freeze(parsed.data);
}
