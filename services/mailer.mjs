import { AppError } from '../errors.mjs';
import { decodeAttachments, messageTooLarge } from './attachments.mjs';
import { assembleMessage, composeContent } from './mime.mjs';
import { collectRecipients, planBatches } from './recipients.mjs';
import { deliver } from './smtp.mjs';

export function createMailer(config, logger, transport = deliver) {
  return {
    /**
     * Sends one message per batch of at most MAIL_BATCH_SIZE recipients. A failed batch does not stop the
     * remaining ones, unless the failure is the connection itself.
     */
    async send({ from, to, cc, bcc, subject, text, isHtml, attachedFiles }) {
      const recipients = collectRecipients({ to, cc, bcc });
      const bodyBytes = Buffer.byteLength(text, 'utf8');
      const { attachments, rawBytes } = decodeAttachments(attachedFiles, config, bodyBytes);
      const content = composeContent({ text, isHtml, attachments });
      const plan = planBatches(recipients, config.MAIL_BATCH_SIZE);

      const batches = plan.map((batch) => ({ ...batch, ok: false, reason: 'Not attempted.', rejected: [] }));
      const outcome = { bodyBytes, attachmentBytes: rawBytes, mimeBytes: 0, batches };

      for (const [index, batch] of plan.entries()) {
        const message = assembleMessage({ from, subject, batch, content });
        if (message.length > config.MAIL_MAX_MESSAGE_BYTES) {
          throw messageTooLarge(message.length, config.MAIL_MAX_MESSAGE_BYTES, bodyBytes, attachments.length + 1);
        }
        outcome.mimeBytes = Math.max(outcome.mimeBytes, message.length);
        const envelope = [...batch.to, ...batch.cc, ...batch.bcc];
        try {
          const result = await transport(config, { from, recipients: envelope, message });
          Object.assign(batches[index], { ok: true, reason: '', rejected: result.rejected });
          logger.info('mail.batch.sent', {
            batch: index + 1,
            of: plan.length,
            recipients: result.accepted.length,
            rejected: result.rejected.length,
            bytes: message.length,
          });
        } catch (error) {
          if (error instanceof AppError) throw error;
          batches[index].reason = error.message;
          logger.error('mail.batch.failed', { batch: index + 1, of: plan.length, error: error.message });
          if (error.fatal) {
            batches.slice(index + 1).forEach((b) => (b.reason = 'Skipped after a connection failure.'));
            break;
          }
        }
      }
      return outcome;
    },
  };
}
