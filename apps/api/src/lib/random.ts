import { randomInt } from "node:crypto";

/** Generates a string of `n` random decimal digits (e.g. "042817"), from a CSPRNG. */
export function randomDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += randomInt(0, 10).toString();
  }
  return out;
}

/** Generates a string of `n` characters drawn uniformly from `alphabet`, from a CSPRNG. */
export function randomFromAlphabet(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[randomInt(0, alphabet.length)];
  }
  return out;
}

/** Short display-only reference for receipts and logs (e.g. "FP-A7K2M3"). */
export function displayReference(): string {
  return `FP-${randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6)}`;
}
