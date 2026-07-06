import { createHash } from 'crypto';
import { readFileSync } from 'fs';

export function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function verifyFileEquals(resolved, expectedText, operation) {
  const actualText = readFileSync(resolved, 'utf8');
  const expected = String(expectedText);
  const expectedBytes = Buffer.byteLength(expected, 'utf8');
  const actualBytes = Buffer.byteLength(actualText, 'utf8');
  return {
    operation,
    method: 'read_after_write',
    verified: actualText === expected,
    expectedBytes,
    actualBytes,
    sha256: sha256Text(actualText),
  };
}

export function describeReadVerification(text) {
  const value = String(text);
  return {
    operation: 'read',
    method: 'read_file',
    verified: true,
    bytes: Buffer.byteLength(value, 'utf8'),
    sha256: sha256Text(value),
  };
}
