import path from 'node:path';
import { AppError } from '../errors.mjs';

const HEADER_ALLOWANCE = 16 * 1024;
const PART_OVERHEAD = 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Base64 grows data by 4/3, plus a CRLF every 76 characters (57 source bytes). */
export const encodedSize = (bytes) => Math.ceil(bytes / 3) * 4 + Math.ceil(bytes / 57) * 2;

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

export function messageTooLarge(estimated, limit, bodyBytes, partCount) {
  const room = limit - HEADER_ALLOWANCE - encodedSize(bodyBytes) - partCount * PART_OVERHEAD;
  const rawRoom = Math.max(0, Math.floor((room * 57) / 78));
  return new AppError(
    413,
    `The message is too large: about ${megabytes(estimated)} once encoded, but the limit for one message is ${megabytes(limit)} ` +
      `(roughly ${megabytes(rawRoom)} of attachments).`,
  );
}

function cleanFilename(value) {
  const name = path.basename(String(value).replace(/\\/g, '/')).trim();
  if (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name)) throw new AppError(400, 'Invalid attachment file name.');
  return name;
}

/**
 * Validates the inline base64 attachments and checks the encoded size from the text length alone,
 * before anything is decoded.
 */
export function decodeAttachments(files, config, bodyBytes) {
  if (files.length === 0) return { attachments: [], rawBytes: 0 };
  if (files.length > config.MAIL_MAX_ATTACHMENTS) {
    throw new AppError(400, `At most ${config.MAIL_MAX_ATTACHMENTS} attachments are allowed.`);
  }

  const prepared = files.map((file) => {
    const filename = cleanFilename(file.filename);
    const content = file.content.replace(/\s+/g, '');
    if (content.length % 4 !== 0 || !BASE64.test(content)) {
      throw new AppError(400, `Attachment "${filename.slice(0, 120)}" is not valid base64.`);
    }
    const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
    return { filename, content, size: (content.length / 4) * 3 - padding };
  });

  const estimated =
    HEADER_ALLOWANCE +
    encodedSize(bodyBytes) +
    prepared.reduce((sum, f) => sum + encodedSize(f.size) + PART_OVERHEAD, 0);
  if (estimated > config.MAIL_MAX_MESSAGE_BYTES) {
    throw messageTooLarge(estimated, config.MAIL_MAX_MESSAGE_BYTES, bodyBytes, prepared.length + 1);
  }

  const attachments = prepared.map((f) => ({
    filename: f.filename,
    contentType: CONTENT_TYPES[path.extname(f.filename).toLowerCase()] ?? 'application/octet-stream',
    data: Buffer.from(f.content, 'base64'),
  }));
  return { attachments, rawBytes: attachments.reduce((sum, a) => sum + a.data.length, 0) };
}
