import { AppError } from '../errors.mjs';

const ADDRESS = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;

export function splitAddresses(value) {
  const parts = Array.isArray(value) ? value : [value ?? ''];
  return parts
    .flatMap((part) => String(part).split(/[,;]/))
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isAddress(value) {
  return value.length <= 254 && ADDRESS.test(value);
}

/** Splits, validates and de-duplicates (case-insensitive). An address keeps its first role: to, then cc, then bcc. */
export function collectRecipients({ to, cc, bcc }) {
  const seen = new Set();
  const invalid = [];
  const roles = { to: [], cc: [], bcc: [] };

  for (const [role, raw] of [['to', to], ['cc', cc], ['bcc', bcc]]) {
    for (const address of splitAddresses(raw)) {
      if (!isAddress(address)) {
        invalid.push(address.slice(0, 80));
        continue;
      }
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      roles[role].push(address);
    }
  }

  if (invalid.length) {
    throw new AppError(400, `Invalid recipient address: ${invalid.slice(0, 5).join(', ')}`);
  }
  if (seen.size === 0) throw new AppError(400, 'No recipients provided.');
  return roles;
}

/** Fills each message up to `size` recipients, in the order to, cc, bcc. */
export function planBatches({ to, cc, bcc }, size) {
  const entries = [
    ...to.map((a) => ['to', a]),
    ...cc.map((a) => ['cc', a]),
    ...bcc.map((a) => ['bcc', a]),
  ];
  const batches = [];
  for (let i = 0; i < entries.length; i += size) {
    const batch = { to: [], cc: [], bcc: [] };
    for (const [role, address] of entries.slice(i, i + size)) batch[role].push(address);
    batches.push(batch);
  }
  return batches;
}
