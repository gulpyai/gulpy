import { InputError, type NewEmail } from "./types.ts";

const ADDRESS = /^[^\s<>@,;:"]+@[^\s<>@,;:"]+\.[^\s<>@,;:"]+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && ADDRESS.test(value);
}

/** RFC 2047 encoded-word for header values that are not plain ASCII. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Throws InputError on a bad address or a line break in the subject. A line
 * break in a header lets the caller add headers of its own, for example Bcc.
 */
export function checkNewEmail(message: NewEmail): void {
  if (message.to.length === 0) throw new InputError("A message needs one or more recipients");
  for (const address of [...message.to, ...(message.cc ?? [])]) {
    if (!isEmailAddress(address)) throw new InputError(`Not a valid email address: ${address}`);
  }
  if (/[\r\n]/.test(message.subject)) throw new InputError("The subject cannot contain a line break");
}

/** Builds an RFC 5322 message. */
export function buildMimeMessage(message: NewEmail): string {
  checkNewEmail(message);

  const headers = [`To: ${message.to.join(", ")}`];
  if (message.cc?.length) headers.push(`Cc: ${message.cc.join(", ")}`);
  headers.push(
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  );
  const body = Buffer.from(message.body_text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** Plain text from HTML. Good enough for an agent to read a message. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
