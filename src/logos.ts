/**
 * The logo images in src/assets/logos. `scripts/fetch-logos.py` gets each one
 * from the site of the company and writes the manifest.
 */
import manifest from "./assets/logos/manifest.json";
import { sha256 } from "./crypto.ts";

export interface LogoImage {
  /** The address of the image on this site. */
  src: string;
  /** `fill`: the image covers the tile. `mark`: the tile shows the image with a margin. */
  kind: "fill" | "mark";
}

export interface LogoFile {
  path: string;
  body: ArrayBuffer;
}

const entries = manifest as Record<string, { file: string; kind: string; source: string }>;
const images = new Map<string, LogoImage>();
const files: LogoFile[] = [];

for (const [id, entry] of Object.entries(entries)) {
  const file = Bun.file(new URL(`./assets/logos/${entry.file}`, import.meta.url));
  if (!(await file.exists())) continue;
  const body = await file.arrayBuffer();
  const path = `/assets/logos/${entry.file}`;
  // The address changes when the image changes, so the browser can keep the image.
  const version = sha256(Buffer.from(body).toString("base64")).slice(0, 10);
  images.set(id, { src: `${path}?v=${version}`, kind: entry.kind === "fill" ? "fill" : "mark" });
  files.push({ path, body });
}

/** The logo image of a connector or of an agent company. */
export function logoImage(id: string): LogoImage | undefined {
  return images.get(id);
}

export function logoFiles(): readonly LogoFile[] {
  return files;
}

/** The addresses that each agent company sends the user back to. */
const AGENT_HOSTS: Record<string, string[]> = {
  claude: ["claude.ai", "claude.com"],
  chatgpt: ["chatgpt.com", "chat.openai.com"],
  grok: ["grok.com", "x.ai"],
};

const AGENT_SCHEMES: Record<string, string> = {
  cursor: "cursor:",
};

function parse(address: string): URL | null {
  try {
    return new URL(address);
  } catch {
    return null;
  }
}

/**
 * The logo of the company that operates an agent. An agent gives its own
 * name, so the name is not proof. The proof is the return address: the logo
 * shows only if each return address of the agent is on the site of the company.
 */
export function agentLogo(redirectUris: readonly string[]): LogoImage | undefined {
  const urls = redirectUris.map(parse);
  if (urls.length === 0 || urls.some((url) => url === null)) return undefined;
  const all = urls as URL[];
  for (const [id, hosts] of Object.entries(AGENT_HOSTS)) {
    if (all.every((url) => url.protocol === "https:" && hosts.includes(url.hostname))) return logoImage(id);
  }
  for (const [id, scheme] of Object.entries(AGENT_SCHEMES)) {
    if (all.every((url) => url.protocol === scheme)) return logoImage(id);
  }
  return undefined;
}
