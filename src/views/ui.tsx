import type { Child, FC, PropsWithChildren } from "hono/jsx";
import type { Viewer } from "../auth.ts";
import { BRAND, CONTACT } from "../brand.ts";
import { CAPABILITIES, type CapabilityId } from "../capabilities.ts";
import type { LogoImage } from "../logos.ts";

const ICONS = {
  mail: ["M3 6.5h18v11H3z", "m3.5 7 8.5 6.5L20.5 7"],
  send: ["M21 3 10.5 13.5", "M21 3l-6.5 18-4-7.5L3 9.5z"],
  calendar: ["M4 6h16v14H4z", "M4 10h16", "M8 3.5v4", "M16 3.5v4"],
  "calendar-plus": ["M4 6h16v14H4z", "M4 10h16", "M8 3.5v4", "M16 3.5v4", "M12 12.5v5", "M9.5 15h5"],
  file: ["M6 3h8l4 4v14H6z", "M14 3v4h4", "M9 12h6", "M9 16h6"],
  search: ["M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "m15.5 15.5 5 5"],
  edit: ["M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z", "m14.5 7.5 3 3"],
  plus: ["M12 5v14", "M5 12h14"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  copy: ["M9 9h10v10H9z", "M5 15V5h10"],
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
  eye: ["M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z", "M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"],
  bolt: ["M13 3 5 13.5h6L10 21l8-10.5h-6z"],
  shield: ["M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z", "m8.8 12 2.3 2.3 4.2-4.3"],
  key: ["M8 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M11.5 12H21", "M17.5 12v3", "M20.5 12v2.5"],
  arrow: ["M5 12h14", "m13 6 6 6-6 6"],
  link: ["M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"],
} as const;

export type IconName = keyof typeof ICONS;

export const Icon: FC<{ name: IconName }> = ({ name }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {ICONS[name].map((d) => (
      <path d={d} />
    ))}
  </svg>
);

/**
 * The mascot: a plug with a mouth. "Plug", read from right to left, is "gulp".
 * The styles in gulpy.css move the parts. `gulp` makes it eat one time.
 */
export const Mascot: FC<{ size?: "small" | "medium" | "large" | "hero"; mood?: "idle" | "gulp" | "loop" | "live" }> = ({
  size = "medium",
  mood = "idle",
}) => (
  <svg class={`mascot mascot-${size} mascot-${mood}`} viewBox="0 0 64 64" aria-hidden="true">
    <g class="mascot-all">
      <rect class="mascot-pin" x="21" y="2" width="6.5" height="14" rx="3.25" fill="#101112" />
      <rect class="mascot-pin" x="36.5" y="2" width="6.5" height="14" rx="3.25" fill="#101112" />
      <rect x="5" y="12" width="54" height="49" rx="21" fill="#C9F73A" />
      <path d="M12 30c0-7 5-12 12-12" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" opacity="0.55" />
      <ellipse class="mascot-cheek" cx="13.5" cy="40" rx="4" ry="2.6" fill="#FF6B7A" />
      <ellipse class="mascot-cheek" cx="50.5" cy="40" rx="4" ry="2.6" fill="#FF6B7A" />
      <g class="mascot-look">
        <g class="mascot-eyes">
          <ellipse cx="22.5" cy="31" rx="3.4" ry="4.3" fill="#101112" />
          <ellipse cx="41.5" cy="31" rx="3.4" ry="4.3" fill="#101112" />
          <circle cx="23.7" cy="29.3" r="1.2" fill="#ffffff" />
          <circle cx="42.7" cy="29.3" r="1.2" fill="#ffffff" />
        </g>
      </g>
      <g class="mascot-mouth">
        <path d="M21 41.5h22c0 7.5-4.6 12-11 12s-11-4.5-11-12z" fill="#101112" />
        <path d="M26.5 50.2c1.2-1.9 3.2-2.9 5.5-2.9s4.3 1 5.5 2.9c-1.5 2-3.3 3.3-5.5 3.3s-4-1.3-5.5-3.3z" fill="#FF6B7A" />
      </g>
    </g>
  </svg>
);

export const Brand: FC<{ href?: string }> = ({ href = "/" }) => (
  <a class="brand" href={href}>
    <Mascot size="small" />
    {BRAND.name}
  </a>
);

/** The logo of the company of an agent. If there is none, a square with the first letter. */
export const Avatar: FC<{ label: string; large?: boolean; image?: LogoImage }> = ({ label, large, image }) =>
  image ? (
    <span class={`avatar avatar-${image.kind}${large ? " avatar-large" : ""}`} aria-hidden="true">
      <img src={image.src} alt="" width={160} height={160} loading="lazy" decoding="async" />
    </span>
  ) : (
    <span class={`avatar${large ? " avatar-large" : ""}`} aria-hidden="true">
      {label.trim().charAt(0).toUpperCase()}
    </span>
  );

export interface Logo {
  name: string;
  /** 6 hex digits */
  color: string;
  /** The logo image of the company */
  image?: LogoImage;
  /** SVG path in a 24 x 24 box */
  icon?: string;
}

/**
 * The logo of a connector: the image of the company, or its mark as a vector,
 * or the first letter. The color is an SVG attribute, not a style, so the
 * Content Security Policy of the pages permits it.
 */
export const ConnectorIcon: FC<{ logo: Logo; small?: boolean; extra?: string }> = ({ logo, small, extra }) => {
  const look = logo.image ? ` tile-${logo.image.kind}` : logo.icon ? "" : " tile-letter";
  return (
    <span class={`tile${small ? " tile-small" : ""}${look}${extra ? ` ${extra}` : ""}`} aria-hidden="true">
      {logo.image ? (
        <img src={logo.image.src} alt="" width={160} height={160} loading="lazy" decoding="async" />
      ) : logo.icon ? (
        <svg viewBox="0 0 24 24">
          <path d={logo.icon} fill={`#${logo.color}`} />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24">
          <rect width="24" height="24" fill={`#${logo.color}`} />
          <text x="12" y="16.6" text-anchor="middle" font-size="13" font-weight="700" fill="#ffffff">
            {logo.name.trim().charAt(0).toUpperCase()}
          </text>
        </svg>
      )}
    </span>
  );
};

export const CapabilityChips: FC<{ capabilities: readonly CapabilityId[] }> = ({ capabilities }) => (
  <span class="chips">
    {capabilities.map((capability) => (
      <span class="chip">{CAPABILITIES[capability].label}</span>
    ))}
  </span>
);

/** What a search engine and a link preview show. Only a public page has it. */
export interface PageMeta {
  description: string;
  /** The public address of the page */
  url: string;
  /** The public address of the picture for the link preview */
  image: string;
}

const Document: FC<PropsWithChildren<{ title: string; bodyClass?: string; script?: string; meta?: PageMeta }>> = ({
  title,
  bodyClass,
  script,
  meta,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {/* A page with the data of a user is not for a search engine. */}
      {!meta && <meta name="robots" content="noindex" />}
      <meta name="theme-color" content="#faf9f5" />
      <title>{title}</title>
      {meta && <meta name="description" content={meta.description} />}
      {meta && <link rel="canonical" href={meta.url} />}
      {meta && <meta property="og:type" content="website" />}
      {meta && <meta property="og:site_name" content={BRAND.name} />}
      {meta && <meta property="og:title" content={title} />}
      {meta && <meta property="og:description" content={meta.description} />}
      {meta && <meta property="og:url" content={meta.url} />}
      {meta && <meta property="og:image" content={meta.image} />}
      {meta && <meta name="twitter:card" content="summary_large_image" />}
      <link rel="icon" href="/assets/icon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/assets/touch-icon.png" />
      <link rel="preload" href="/assets/nunito.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
      <link rel="stylesheet" href="/assets/gulpy.css" />
      <link rel="stylesheet" href="/assets/pages.css" />
    </head>
    <body class={bodyClass}>
      {children}
      {script && <script src={script} />}
    </body>
  </html>
);

/** The narrow window for sign-in and approval. An agent opens it as a pop-up. */
export const LinkPage: FC<PropsWithChildren<{ title: string; script?: string }>> = ({ title, script, children }) => (
  <Document title={`${title} · ${BRAND.name}`} bodyClass="link-body" script={script}>
    <main class="link-card">{children}</main>
    <p class="link-brand">
      <Mascot size="small" />
      Secured by {BRAND.name}
    </p>
  </Document>
);

export type SiteSection = "tools" | "developers" | "none";

/** The foot of each site page: where to get help, and the rules. */
const SiteFoot: FC = () => (
  <footer class="foot">
    <div class="foot-inner">
      <div class="foot-brand">
        <Brand />
        <p>{BRAND.promise}</p>
      </div>
      <nav class="foot-group" aria-label="Product">
        <h2>Product</h2>
        <a href="/">My tools</a>
        <a href="/#how">How it works</a>
      </nav>
      <nav class="foot-group" aria-label="Help">
        <h2>Help</h2>
        <a href="/support">Support</a>
        <a href="/security">Security</a>
        <a href={`mailto:${CONTACT.support}`}>{CONTACT.support}</a>
      </nav>
      <nav class="foot-group" aria-label="Rules">
        <h2>Rules</h2>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
      </nav>
    </div>
    <p class="foot-line">
      <span>© 2026 {BRAND.name}</span>
      <span>
        {BRAND.name} is not affiliated with, endorsed by or sponsored by the companies whose products are named on this
        site. Their names and logos belong to their owners.
      </span>
      <span>
        {BRAND.name}’s use of information received from Google APIs adheres to the{" "}
        <a href="/privacy#google">Google API Services User Data Policy</a>, including the Limited Use requirements.
      </span>
    </p>
  </footer>
);

export const SitePage: FC<
  PropsWithChildren<{ title: string; viewer: Viewer | null; current: SiteSection; script?: string; meta?: PageMeta }>
> = ({ title, viewer, current, script, meta, children }) => (
  <Document title={`${title} · ${BRAND.name}`} script={script} meta={meta}>
    <a class="skip" href="#main">
      Skip to content
    </a>
    <header class="site-top">
      <div class="site-top-inner">
        <Brand />
        {viewer ? (
          <nav class="site-nav">
            <a href="/" aria-current={current === "tools" ? "page" : undefined}>
              My tools
            </a>
            <span class="site-user">{viewer.user.email}</span>
            <form method="post" action="/auth/signout">
              <input type="hidden" name="csrf" value={viewer.csrf} />
              <button class="link-button" type="submit">
                Sign out
              </button>
            </form>
          </nav>
        ) : (
          <nav class="site-nav">
            <a href="/#how">How it works</a>
            <a class="btn btn-dark btn-small" href="/#start">
              Sign in
            </a>
          </nav>
        )}
      </div>
    </header>
    {children}
    <SiteFoot />
  </Document>
);

export const Notice: FC<{ kind: "error" | "warn" | "ok" | "dev"; children: Child }> = ({ kind, children }) => (
  <p class={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}>
    {children}
  </p>
);

export function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** "2 minutes ago". The pages are made on the server, so the reference time is the server time. */
/** "Oct 28, 2027" */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function timeAgo(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return "a moment ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
