// imageHash.ts
// Lightweight image fingerprint for duplicate detection.
//
// We hash the RAW image bytes with SHA-256. This is fast, allocates almost no
// extra memory (it streams over the buffer we already downloaded for the CV
// call) and never decodes the image into a bitmap — unlike a perceptual hash,
// which is CPU/memory heavy and was OOM-killing the 256MiB function.
//
// Trade-off: SHA-256 only catches EXACT re-uploads of the same file. A user who
// re-compresses or re-crops the image would slip past — acceptable for our case
// (the goal is to stop the same photo being submitted again and again).

import { createHash } from 'crypto';

/** SHA-256 hex digest of the raw image bytes. */
export function computeImageHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
