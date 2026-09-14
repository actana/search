/**
 * Id generation.
 *
 * `generateId` is a UUID v4 and is what every lifted module calls, because
 * every row it writes has a UUID primary key in Studio and the phase-4 data
 * move compares them. It does not go through `crypto.randomUUID()`
 * unconditionally: that call requires a secure context in a browser, and the
 * same module is reachable from a page served over plain HTTP.
 *
 * `shortId` is the opaque, non-cryptographic form Control uses for its own
 * records — `${prefix}-${base36 time}-${base36 random}`. Ids are treated as
 * opaque strings; nothing parses the segments after the prefix.
 */

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string is a well-formed UUID (any version). */
export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const URL_SAFE_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/**
 * A short, URL-safe random id. Replaces `nanoid`: `crypto.getRandomValues()`
 * works in every context, including a non-secure one.
 */
export function generateShortId(size = 21): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);

  let id = "";
  for (let i = 0; i < size; i++) {
    id += URL_SAFE_ALPHABET[bytes[i] & 63];
  }
  return id;
}

/** Control's opaque record id: `${prefix}-${base36 time}-${base36 random}`. */
export function shortId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
