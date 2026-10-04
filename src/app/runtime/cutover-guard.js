/**
 * Cutover guard. A channel marked `cutoverRequired` (the seeded
 * `telegram-main`, created to take over from the retired Cloudflare Worker)
 * must not start delivering while its `notBefore` cutoff is unset; otherwise
 * articles published before the cutover could be posted. Resume, manual runs,
 * operator output retries, and runs of an unpaused channel are all refused
 * until `notBefore` is set. Read-only preview stays allowed.
 */

import { RuntimeError } from './errors.js';

/**
 * @param {{ cutoverRequired?: boolean, notBefore?: string|null }} record Channel record.
 * @returns {boolean} Whether the channel is still waiting for its cutover instant.
 */
export function isCutoverPending(record) {
  return record?.cutoverRequired === true && (record.notBefore === null || record.notBefore === undefined);
}

/**
 * @param {{ id: string, cutoverRequired?: boolean, notBefore?: string|null }} record Channel record.
 * @throws {RuntimeError} `cutover_required` while the cutover instant is unset.
 */
export function assertCutoverReady(record) {
  if (isCutoverPending(record)) {
    throw new RuntimeError(
      'cutover_required',
      `Channel "${record.id}" needs its notBefore cutover instant before it can deliver`,
    );
  }
}
