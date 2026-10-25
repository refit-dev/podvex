"use node";

import { ConvexError, v } from "convex/values";
import Stripe from "stripe";

import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

// Typed like the removed field under old stripe types, like the new location under new ones.
type InvoiceSubscription<T> = T extends { subscription: infer S }
  ? S
  : T extends { parent: infer P }
    ? NonNullable<P> extends { subscription_details: infer D }
      ? NonNullable<D> extends { subscription: infer S }
        ? S | null
        : string | null
      : string | null
    : string | null;

// The old top-level field when present (old-version payloads), otherwise the new location.
function getInvoiceSubscription<T extends object>(invoice: T): InvoiceSubscription<T> {
  const legacy: unknown = Reflect.get(invoice, 'subscription');
  const parent: unknown = Reflect.get(invoice, 'parent');
  const details: unknown =
    parent && typeof parent === 'object' ? Reflect.get(parent, 'subscription_details') : undefined;
  const moved: unknown =
    details && typeof details === 'object' ? Reflect.get(details, 'subscription') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null)) as InvoiceSubscription<T>;
}

type Metadata = {
  userId: string; // clerkId
};

export const pay = action({
  args: { priceId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      console.warn("[STRIPE PAY] User not authenticated");
      throw new ConvexError("[STRIPE PAY] User must be logged in to subscribe");
    }

    const domain =
      (process.env.NEXT_PUBLIC_URL as string) ?? "http://localhost:3000";
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-09-30.endive",
    });
    const session = await stripe.checkout.sessions.create({
      line_items: [{ price: args.priceId!, quantity: 1 }],
      customer_email: identity.email,
      metadata: {
        userId: identity.subject,
      },
      mode: "subscription",
      success_url: `${domain}/profile/${identity.subject}`,
      cancel_url: `${domain}/get-verified/${identity.subject}`,
    });

    return session.url!;
  },
});

export const createPortal = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      console.warn("[CREATE PORTAL] User not authenticated");
      throw new ConvexError("[CREATE PORTAL] User not authenticated");
    }

    const customerUser = await ctx.runQuery(internal.users.getUserCustomer, {
      clerkId: identity.subject,
    });
    if (!customerUser?.stripeCustomerId) {
      console.warn("[CREATE PORTAL] User has no stripe customer id");
      throw new ConvexError("[CREATE PORTAL] User has no stripe customer id");
    }

    const domain =
      (process.env.NEXT_PUBLIC_URL as string) ?? "http://localhost:3000";
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-09-30.endive",
    });

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerUser.stripeCustomerId,
      return_url: `${domain}`,
    });

    return portalSession.url!;
  },
});

export const fulfill = internalAction({
  args: { signature: v.string(), payload: v.string() },
  handler: async (ctx, args) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-09-30.endive",
    });

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;
    try {
      const event = stripe.webhooks.constructEvent(
        args.payload,
        args.signature,
        webhookSecret,
      );

      if (event.type === "checkout.session.completed") {
        const completedEvent = event.data.object as Stripe.Checkout.Session & {
          metadata: Metadata;
        };

        const subscription = await stripe.subscriptions.retrieve(
          completedEvent.subscription as string,
        );

        console.log("checkout session completed subscription: ", subscription);

        const userId = completedEvent.metadata.userId;

        await ctx.runMutation(internal.users.updateSubscription, {
          clerkId: userId,
          priceId: subscription.items.data[0].price.id,
          stripeCustomerId: subscription.customer as string,
        });
      }

      if (event.type === "invoice.paid") {
        const completedEvent = event.data.object as Stripe.Invoice & {
          metadata: Metadata;
        };

        const subscription = await stripe.subscriptions.retrieve(
          (getInvoiceSubscription(completedEvent)) as string,
        );

        console.log("invoice paid subscription: ", subscription);

        await ctx.runMutation(internal.users.updateSubscriptionByPriceId, {
          priceId: subscription.items.data[0]?.price.id,
          clerkId: completedEvent.metadata.userId,
        });
      }

      if (event.type === "customer.subscription.deleted") {
        // The customer subscription stopped
        // ❌ Revoke access to the product
        const completedEvent = event.data.object as Stripe.Subscription & {
          metadata: Metadata;
        };
        const subscription = await stripe.subscriptions.retrieve(
          completedEvent.id as string,
        );
        const userId = completedEvent.metadata.userId;

        await ctx.runMutation(internal.users.updateSubscription, {
          clerkId: userId,
          priceId: subscription.items.data[0]?.price.id,
          stripeCustomerId: subscription.customer as string,
        });
      }

      return { success: true };
    } catch (err) {
      console.error(err);
      return { success: false, error: (err as { message: string }).message };
    }
  },
});
