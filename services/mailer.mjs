import { AppError } from '../errors.mjs';
import { loadAttachments, messageTooLarge } from './attachments.mjs';
import { assembleMessage, composeContent } from './mime.mjs';
import { collectRecipients, planBatches } from './recipients.mjs';
import { deliver } from './smtp.mjs';

export function createMailer(config, logger, transport = deliver) {
  return {
    /**
     * Sends one message per batch of at most MAIL_BATCH_SIZE recipients. A failed batch does not stop the
     * remaining ones, unless the failure is the connection itself.
     */
    async send({ from, to, cc, bcc, subject, text, isHtml, attachments: requested }) {
      const recipients = collectRecipients({ to, cc, bcc });
      const bodyBytes = Buffer.byteLength(text, 'utf8');
      const attachments = await loadAttachments(requested, config, bodyBytes);
      const content = composeContent({ text, isHtml, attachments });
      const batches = planBatches(recipients, config.MAIL_BATCH_SIZE);

      const outcome = { total: batches.length, sent: 0, failures: [], rejected: [] };

      for (const [index, batch] of batches.entries()) {
        const message = assembleMessage({ from, subject, batch, content });
        if (message.length > config.MAIL_MAX_MESSAGE_BYTES) {
          throw messageTooLarge(message.length, config.MAIL_MAX_MESSAGE_BYTES, bodyBytes, attachments.length + 1);
        }
        const envelope = [...batch.to, ...batch.cc, ...batch.bcc];
        try {
          const result = await transport(config, { from, recipients: envelope, message });
          outcome.sent += 1;
          outcome.rejected.push(...result.rejected);
          logger.info('mail.batch.sent', {
            batch: index + 1,
            of: batches.length,
            recipients: result.accepted.length,
            rejected: result.rejected.length,
            bytes: message.length,
          });
        } catch (error) {
          if (error instanceof AppError) throw error;
          outcome.failures.push({ batch: index + 1, reason: error.message });
          logger.error('mail.batch.failed', { batch: index + 1, of: batches.length, error: error.message });
          if (error.fatal) break;
        }
      }
      return outcome;
    },
  };
}
