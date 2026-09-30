/**
 * Paid plans through Stripe. The plans and their prices live in Stripe, made by the
 * `stripe` script of the marketing site. Gulpy learns who paid from the Stripe webhook,
 * and keeps one row for each person in the `subscriptions` table.
 *
 * Off when the settings have no Stripe key: self-hosters run Gulpy with no payments.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Deps } from "./deps.ts";
import { ACTIVE_STATUSES, type PaidPlan, type Subscription, type User } from "./store.ts";

export const PLANS: readonly PaidPlan[] = ["personal", "family", "business"];
export const INTERVALS = ["monthly", "yearly"] as const;
export type Interval = (typeof INTERVALS)[number];

export const PLAN_NAMES: Record<PaidPlan | "free", string> = {
  free: "Free",
  personal: "Personal",
  family: "Family",
  business: "Business",
};

/** The list of calls of a person on Free goes back this many days. A paid plan keeps `LEGAL.callLogDays`. */
export const FREE_HISTORY_DAYS = 7;

/** A signed webhook must arrive within this time. Stripe signs each delivery with the time. */
const SIGNATURE_TOLERANCE_S = 300;

/** The payment links stay in memory this long, so a click does not always call Stripe. */
const LINKS_TTL_MS = 10 * 60_000;

export function isPlan(value: unknown): value is PaidPlan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

export function isInterval(value: unknown): value is Interval {
  return typeof value === "string" && (INTERVALS as readonly string[]).includes(value);
}

/** True when this Gulpy sells plans. */
export function billingOn(deps: Deps): boolean {
  return deps.config.stripe !== undefined;
}

/** True while the person has the plan. `past_due`: the card failed and Stripe tries again. */
export function isPaid(subscription: Subscription | null): boolean {
  return subscription !== null && ACTIVE_STATUSES.includes(subscription.status);
}

export interface PlanView {
  plan: PaidPlan | "free";
  name: string;
  interval: Interval | null;
  /** The number of users on Business. */
  quantity: number;
  /** The end of the paid period, or null on Free. */
  periodEnd: number | null;
  /** True when the person canceled: the plan ends at `periodEnd`. */
  ends: boolean;
  /** True when the person has a Stripe customer: the portal can open. */
  manage: boolean;
}

export function planOf(deps: Deps, userId: string): PlanView {
  const subscription = deps.store.subscription(userId);
  const paid = isPaid(subscription);
  return {
    plan: paid && subscription ? subscription.plan : "free",
    name: PLAN_NAMES[paid && subscription ? subscription.plan : "free"],
    interval: paid && subscription ? subscription.interval : null,
    quantity: paid && subscription ? subscription.quantity : 1,
    periodEnd: paid && subscription ? subscription.periodEnd : null,
    ends: paid && subscription ? subscription.cancelAtPeriodEnd : false,
    manage: subscription !== null,
  };
}

// ---------- The Stripe API ----------

interface StripePrice {
  id: string;
  lookup_key: string | null;
  recurring: { interval: string } | null;
  metadata?: Record<string, string>;
}

interface StripeSubscription {
  id: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end: boolean;
  /** Older API versions put the period on the subscription. */
  current_period_end?: number;
  metadata?: Record<string, string>;
  items: { data: { quantity?: number; current_period_end?: number; price: StripePrice }[] };
}

interface StripeCheckoutSession {
  id: string;
  mode: string;
  status: string;
  client_reference_id: string | null;
  customer: string | { id: string } | null;
  customer_details: { email: string | null } | null;
  subscription: string | StripeSubscription | null;
}

interface StripeCustomer {
  id: string;
  email: string | null;
}

interface StripePaymentLink {
  id: string;
  url: string;
  active: boolean;
  metadata: Record<string, string>;
}

interface StripeList<T> {
  data: T[];
}

/** A generic event. The handlers look at `type` and `data.object`. */
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

async function stripe<T>(deps: Deps, method: "GET" | "POST", path: string, params: Record<string, string> = {}): Promise<T> {
  const key = deps.config.stripe?.secretKey;
  if (!key) throw new Error("Stripe is not set up");
  const query = new URLSearchParams(params).toString();
  const url = method === "GET" && query ? `https://api.stripe.com/v1${path}?${query}` : `https://api.stripe.com/v1${path}`;
  const response = await deps.fetch(url, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? query : undefined,
  });
  const json = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(`Stripe ${method} ${path}: ${json.error?.message ?? `HTTP ${response.status}`}`);
  return json;
}

const linkCache = new Map<string, { at: number; links: StripePaymentLink[] }>();

/** The active payment links of the account, by the lookup key in their metadata. */
async function paymentLinks(deps: Deps): Promise<Map<string, StripePaymentLink>> {
  const key = deps.config.stripe?.secretKey ?? "";
  const cached = linkCache.get(key);
  const now = deps.now();
  const links =
    cached && now - cached.at < LINKS_TTL_MS
      ? cached.links
      : (await stripe<StripeList<StripePaymentLink>>(deps, "GET", "/payment_links", { active: "true", limit: "100" })).data;
  linkCache.set(key, { at: now, links });
  return new Map(links.filter((link) => link.metadata.lookup_key).map((link) => [link.metadata.lookup_key ?? "", link]));
}

/**
 * The address of the Stripe checkout for a plan. The link carries the user id and the email,
 * so the payment lands on this account. Null when Stripe has no link for the plan.
 */
export async function checkoutUrl(deps: Deps, user: User, plan: PaidPlan, interval: Interval): Promise<string | null> {
  const link = (await paymentLinks(deps)).get(`${plan}_${interval}`);
  if (!link) return null;
  const url = new URL(link.url);
  url.searchParams.set("client_reference_id", user.id);
  url.searchParams.set("prefilled_email", user.email);
  return url.toString();
}

/** The address of the Stripe customer portal, where the person cancels, changes the plan or the card. */
export async function portalUrl(deps: Deps, customerId: string, returnUrl: string): Promise<string> {
  const session = await stripe<{ url: string }>(deps, "POST", "/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

// ---------- The webhook ----------

/**
 * Checks the `Stripe-Signature` header: `t=<seconds>,v1=<hmac>`. The HMAC-SHA256 of
 * `<t>.<payload>` with the endpoint secret must match one `v1`, and `t` must be recent.
 */
export function verifySignature(payload: string, header: string | undefined, secret: string, now: number): boolean {
  if (!header) return false;
  const parts = new Map<string, string[]>();
  for (const item of header.split(",")) {
    const [name, value] = item.trim().split("=", 2);
    if (!name || value === undefined) continue;
    parts.set(name, [...(parts.get(name) ?? []), value]);
  }
  const timestamp = Number(parts.get("t")?.[0]);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest();
  return (parts.get("v1") ?? []).some((signature) => {
    const given = Buffer.from(signature, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

function planFrom(subscription: StripeSubscription): PaidPlan | null {
  const price = subscription.items.data[0]?.price;
  for (const value of [subscription.metadata?.plan, price?.metadata?.plan, price?.lookup_key?.split("_")[0]]) {
    if (isPlan(value)) return value;
  }
  return null;
}

function intervalFrom(subscription: StripeSubscription): Interval | null {
  const meta = subscription.metadata?.interval;
  if (isInterval(meta)) return meta;
  const interval = subscription.items.data[0]?.price.recurring?.interval;
  return interval === "month" ? "monthly" : interval === "year" ? "yearly" : null;
}

/** Writes the row of the person from the subscription object of Stripe. */
function apply(deps: Deps, user: User, subscription: StripeSubscription): string {
  const plan = planFrom(subscription);
  if (!plan) return `ignored: no plan on ${subscription.id}`;
  const item = subscription.items.data[0];
  const periodEnd = item?.current_period_end ?? subscription.current_period_end;
  const now = deps.now();
  const before = deps.store.subscription(user.id);
  const row: Subscription = {
    userId: user.id,
    customerId: idOf(subscription.customer) ?? "",
    subscriptionId: subscription.id,
    plan,
    status: subscription.status,
    interval: intervalFrom(subscription),
    quantity: item?.quantity ?? 1,
    periodEnd: periodEnd ? periodEnd * 1000 : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    updatedAt: now,
  };
  deps.store.saveSubscription(row);
  const after = planOf(deps, user.id);
  const wasPaid = isPaid(before);
  if (wasPaid !== isPaid(row) || (before && before.plan !== row.plan)) {
    deps.store.audit({
      ts: now,
      userId: user.id,
      appId: null,
      connectionId: null,
      action: "plan.change",
      detail: after.plan === "free" ? "Free" : `${after.name}${row.interval ? `, billed ${row.interval}` : ""}`,
      status: null,
    });
  }
  return `${after.plan} (${row.status}) for ${user.id}`;
}

/** The person for a Stripe customer: by the user id that the checkout carried, by an earlier row, or by email. */
async function resolveUser(deps: Deps, customerId: string | null, hint: { userId?: string | null; email?: string | null }): Promise<User | null> {
  if (hint.userId) {
    const user = deps.store.userById(hint.userId);
    if (user) return user;
  }
  if (customerId) {
    const row = deps.store.subscriptionByCustomer(customerId);
    if (row) return deps.store.userById(row.userId);
  }
  let email = hint.email ?? null;
  if (!email && customerId) email = (await stripe<StripeCustomer>(deps, "GET", `/customers/${customerId}`)).email;
  return email ? deps.store.userByEmail(email.trim().toLowerCase()) : null;
}

/** Handles one event. Returns one line for the log. Unknown events are fine: Stripe sends what the endpoint asked for. */
export async function handleEvent(deps: Deps, event: StripeEvent): Promise<string> {
  const object = event.data.object;
  if (event.type === "checkout.session.completed") {
    const session = object as unknown as StripeCheckoutSession;
    if (session.mode !== "subscription" || !session.subscription) return "ignored: not a subscription";
    const customerId = idOf(session.customer);
    const user = await resolveUser(deps, customerId, {
      userId: session.client_reference_id,
      email: session.customer_details?.email,
    });
    if (!user) return `ignored: no user for ${customerId ?? "no customer"}`;
    const subscription =
      typeof session.subscription === "string"
        ? await stripe<StripeSubscription>(deps, "GET", `/subscriptions/${session.subscription}`)
        : session.subscription;
    return apply(deps, user, subscription);
  }
  if (event.type.startsWith("customer.subscription.")) {
    const subscription = object as unknown as StripeSubscription;
    const customerId = idOf(subscription.customer);
    const user = await resolveUser(deps, customerId, {});
    if (!user) return `ignored: no user for ${customerId ?? "no customer"}`;
    return apply(deps, user, subscription);
  }
  return "ignored";
}

/**
 * When the person comes back from the checkout page, the plan can show at once: this reads
 * the session from Stripe and applies it. The webhook does the same a moment later, so a
 * closed browser tab loses nothing. False when the session is not paid or not this person's.
 */
export async function completeCheckout(deps: Deps, user: User, sessionId: string): Promise<boolean> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return false;
  const session = await stripe<StripeCheckoutSession>(deps, "GET", `/checkout/sessions/${sessionId}`, {
    "expand[]": "subscription",
  });
  const mine = session.client_reference_id === user.id || session.customer_details?.email?.toLowerCase() === user.email;
  if (!mine || session.status !== "complete" || !session.subscription || typeof session.subscription === "string") return false;
  apply(deps, user, session.subscription);
  return true;
}
