import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors.mjs';

const HEADER_ALLOWANCE = 16 * 1024;
const PART_OVERHEAD = 1024;

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

const notFound = (name) => new AppError(400, `Attachment not found: ${String(name).slice(0, 120)}`);

/**
 * Resolves attachment names inside MAIL_ATTACHMENT_DIR only, checks the encoded size
 * from file metadata first, and only then reads the files.
 */
export async function loadAttachments(requested, config, bodyBytes) {
  if (requested.length === 0) return [];
  if (requested.length > config.MAIL_MAX_ATTACHMENTS) {
    throw new AppError(400, `At most ${config.MAIL_MAX_ATTACHMENTS} attachments are allowed.`);
  }

  let root;
  try {
    root = await realpath(path.resolve(config.MAIL_ATTACHMENT_DIR));
  } catch {
    throw new AppError(500, 'The attachment directory is not available on the server.');
  }

  const files = [];
  for (const entry of requested) {
    const name = typeof entry === 'string' ? entry : entry.path;
    let real;
    try {
      real = await realpath(path.resolve(root, name));
    } catch {
      throw notFound(name);
    }
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw notFound(name);
    const info = await stat(real);
    if (!info.isFile()) throw notFound(name);
    files.push({ real, filename: path.basename(name), size: info.size });
  }

  const estimated =
    HEADER_ALLOWANCE +
    encodedSize(bodyBytes) +
    files.reduce((sum, f) => sum + encodedSize(f.size) + PART_OVERHEAD, 0);
  if (estimated > config.MAIL_MAX_MESSAGE_BYTES) {
    throw messageTooLarge(estimated, config.MAIL_MAX_MESSAGE_BYTES, bodyBytes, files.length + 1);
  }

  return Promise.all(
    files.map(async (f) => ({
      filename: f.filename,
      contentType: CONTENT_TYPES[path.extname(f.filename).toLowerCase()] ?? 'application/octet-stream',
      data: await readFile(f.real),
    })),
  );
}
