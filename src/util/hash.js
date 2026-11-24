import { createHash } from 'node:crypto';

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
export const sha384Base64 = (data) => createHash('sha384').update(data).digest('base64');
export const short = (hash, n = 12) => String(hash).slice(0, n);
