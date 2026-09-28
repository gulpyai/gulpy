import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

/** Short random id for rows that are not secrets, for example `conn_Zk3...`. */
export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/** 256-bit random bearer secret, for example `access_...`. */
export function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** Tokens are high-entropy, so a plain SHA-256 is a safe lookup key. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmac(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Derives a separate 32-byte key for each purpose from the master key.
 * The purpose labels start with "connecty", the first name of the product.
 * Do not change a label: data that is stored with it becomes unreadable.
 */
export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), purpose, 32));
}

/**
 * AES-256-GCM. `aad` binds the ciphertext to its row, so a sealed value
 * copied into a different row does not decrypt.
 */
export function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), body.toString("base64url"), tag.toString("base64url")].join(".");
}

export function open(key: Buffer, sealed: string, aad: string): string {
  const [version, iv, body, tag] = sealed.split(".");
  if (version !== "v1" || !iv || body === undefined || !tag) {
    throw new Error("Sealed value has an unknown format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function otpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
