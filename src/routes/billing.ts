/** The Stripe webhook. The pages for checkout and the customer portal are in pages.tsx. */
import { Hono } from "hono";
import { handleEvent, verifySignature, type StripeEvent } from "../billing.ts";
import type { Deps } from "../deps.ts";

export function billingRoutes(deps: Deps): Hono {
  const app = new Hono();

  // Stripe posts each event here. No cookie, no CSRF: the signature is the proof.
  app.post("/stripe/webhook", async (c) => {
    const stripe = deps.config.stripe;
    if (!stripe) return c.text("Payments are not set up", 404);
    const payload = await c.req.text();
    if (!verifySignature(payload, c.req.header("stripe-signature"), stripe.webhookSecret, deps.now())) {
      return c.text("Bad signature", 400);
    }
    let event: StripeEvent;
    try {
      event = JSON.parse(payload) as StripeEvent;
    } catch {
      return c.text("Bad JSON", 400);
    }
    if (typeof event.type !== "string" || typeof event.data?.object !== "object") return c.text("Bad event", 400);
    // An error here gives a 500, and Stripe sends the event again later.
    const outcome = await handleEvent(deps, event);
    console.log(`[gulpy] stripe ${event.type}: ${outcome}`);
    return c.json({ received: true });
  });

  return app;
}
