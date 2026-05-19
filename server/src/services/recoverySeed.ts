import crypto from "node:crypto";
import bcrypt from "bcrypt";

// One-time recovery code shown to the user at registration. Format:
//   XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
// Eight groups of four lowercase hex characters separated by hyphens — 32 hex
// characters of payload, i.e. 128 bits of entropy. Easy to write down, easy
// to type, plenty of resistance against guessing when paired with the
// existing login-lockout (the recovery endpoint feeds the same counters as
// /auth/login).
//
// Server stores only bcrypt(normalised seed). The plaintext seed is shown to
// the user exactly once, at registration or rotation, and never again.

const GROUP_SIZE = 4;
const GROUP_COUNT = 8;
const HEX_LENGTH = GROUP_SIZE * GROUP_COUNT;          // 32 chars
const BYTE_LENGTH = HEX_LENGTH / 2;                   // 16 bytes = 128 bits

export function generateRecoverySeed(): string {
  const hex = crypto.randomBytes(BYTE_LENGTH).toString("hex");
  return hex.match(new RegExp(`.{${GROUP_SIZE}}`, "g"))!.join("-");
}

function normalise(input: string): string {
  // Strip hyphens and whitespace, lowercase. Users may enter the seed with
  // varying separator placement or capitalisation; bcrypt input must be
  // canonical so it matches whatever was hashed at registration.
  return input.replace(/[\s-]/g, "").toLowerCase();
}

export function isValidRecoverySeedFormat(input: unknown): input is string {
  if (typeof input !== "string") return false;
  return /^[0-9a-f]{32}$/.test(normalise(input));
}

export async function hashRecoverySeed(seed: string, cost: number): Promise<string> {
  return bcrypt.hash(normalise(seed), cost);
}

export async function verifyRecoverySeed(seed: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(normalise(seed), hash);
}
