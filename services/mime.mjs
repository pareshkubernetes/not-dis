import { randomBytes, randomUUID } from 'node:crypto';

const CRLF = '\r\n';

export function base64Lines(buffer) {
  const encoded = buffer.toString('base64');
  const lines = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return lines.join(CRLF);
}

/** RFC 2047 encoding for header text that is not plain ASCII. */
export function encodeHeader(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words = [];
  let current = '';
  for (const char of value) {
    if (Buffer.byteLength(current + char) > 42) {
      words.push(current);
      current = '';
    }
    current += char;
  }
  if (current) words.push(current);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(`${CRLF} `);
}

const quoted = (value) => `"${encodeHeader(value).replace(/[\\"]/g, '\\$&')}"`;

/** The part of the message shared by every batch: body and attachments. */
export function composeContent({ text, isHtml, attachments }) {
  const bodyType = `text/${isHtml ? 'html' : 'plain'}; charset=UTF-8`;
  const encodedText = base64Lines(Buffer.from(text, 'utf8'));

  if (attachments.length === 0) {
    return {
      headers: ['MIME-Version: 1.0', `Content-Type: ${bodyType}`, 'Content-Transfer-Encoding: base64'],
      body: Buffer.from(encodedText + CRLF, 'latin1'),
    };
  }

  const boundary = `=_${randomBytes(12).toString('hex')}`;
  const parts = [
    `--${boundary}${CRLF}Content-Type: ${bodyType}${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${encodedText}${CRLF}`,
  ];
  for (const file of attachments) {
    parts.push(
      `--${boundary}${CRLF}` +
        `Content-Type: ${file.contentType}; name=${quoted(file.filename)}${CRLF}` +
        `Content-Disposition: attachment; filename=${quoted(file.filename)}${CRLF}` +
        `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
        `${base64Lines(file.data)}${CRLF}`,
    );
  }
  parts.push(`--${boundary}--${CRLF}`);

  return {
    headers: ['MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`],
    body: Buffer.from(parts.join(''), 'latin1'),
  };
}

const addressList = (list) => list.join(`,${CRLF} `);

/** Bcc recipients are deliberately absent: they travel only in the SMTP envelope. */
export function assembleMessage({ from, subject, batch, content }) {
  const domain = from.split('@')[1];
  const headers = [
    `From: ${from}`,
    `To: ${batch.to.length ? addressList(batch.to) : 'undisclosed-recipients:;'}`,
    ...(batch.cc.length ? [`Cc: ${addressList(batch.cc)}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    ...content.headers,
  ];
  return Buffer.concat([Buffer.from(headers.join(CRLF) + CRLF + CRLF, 'latin1'), content.body]);
}
