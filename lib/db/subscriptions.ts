import { getDb } from "./index";
import type { UsageProvider } from "./usage";

/**
 * The subscription registry (EP-10 Spec C) — what each plan costs and
 * what it allows, so usage renders against something.
 *
 * ── Manual entry is the source of truth ─────────────────────────────────
 * Three rows, typed once, ~60 seconds. That is the only 100%-reliable
 * source: none of the three providers exposes plan/price to a consumer
 * account programmatically, and EP-15's receipt/browser collectors are
 * best-effort by nature. So `source='manual'` **always wins** — a
 * collector may fill an empty row or update one it wrote itself, but it
 * can never overwrite something the user typed. Getting this backwards
 * would mean a flaky scraper silently rewriting the user's own numbers.
 *
 * `cap_notes` is prose, not policy. Cap semantics change often enough
 * that hardcoding them as truth would guarantee the app is confidently
 * wrong within a quarter; seeding an editable default keeps the
 * explanation useful and clearly the user's to correct.
 */

export type SubscriptionSource = "manual" | "receipt" | "browser";

export interface Subscription {
  provider: UsageProvider;
  plan_name: string | null;
  price_usd_month: number | null;
  renewal_day: number | null;
  cap_notes: string | null;
  source: SubscriptionSource;
  updated_at: number;
}

export interface SubscriptionInput {
  plan_name?: string | null;
  price_usd_month?: number | null;
  renewal_day?: number | null;
  cap_notes?: string | null;
  source?: SubscriptionSource;
}

const COLUMNS = `provider, plan_name, price_usd_month, renewal_day,
  cap_notes, source, updated_at`;

/**
 * Default cap explanations, seeded on first write so the Usage tab has
 * something honest to say before the user edits anything. Deliberately
 * qualitative — a number here would read as a guarantee.
 */
export const DEFAULT_CAP_NOTES: Record<UsageProvider, string> = {
  claude:
    "Rolling 5-hour window plus a weekly cap, shared across claude.ai, Claude Code, and Cowork.",
  codex:
    "Rolling 5-hour window plus a weekly cap, token-based and weighted by reasoning effort.",
  google:
    "Per-model daily quotas that refresh roughly every 5 hours, under a weekly ceiling.",
};

export function listSubscriptions(): Subscription[] {
  return getDb()
    .prepare(`SELECT ${COLUMNS} FROM subscriptions ORDER BY provider ASC`)
    .all() as Subscription[];
}

export function getSubscription(provider: UsageProvider): Subscription | null {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM subscriptions WHERE provider = ?`)
    .get(provider) as Subscription | undefined;
  return row ?? null;
}

/**
 * Write a subscription row.
 *
 * Precedence: a non-manual write is refused when a manual row already
 * exists. The refusal is a return value (`{written: false}`), not a
 * throw — a collector finding user-entered data is the normal, expected
 * case, not an error.
 *
 * Fields left `undefined` keep their current value, so a collector that
 * only learned the price doesn't blank out the plan name.
 */
export function upsertSubscription(
  provider: UsageProvider,
  input: SubscriptionInput,
): { written: boolean; subscription: Subscription | null } {
  const source: SubscriptionSource = input.source ?? "manual";
  const existing = getSubscription(provider);

  if (existing && existing.source === "manual" && source !== "manual") {
    return { written: false, subscription: existing };
  }

  const next = {
    provider,
    plan_name: pick(input.plan_name, existing?.plan_name ?? null),
    price_usd_month: pick(
      input.price_usd_month,
      existing?.price_usd_month ?? null,
    ),
    renewal_day: pick(input.renewal_day, existing?.renewal_day ?? null),
    cap_notes: pick(
      input.cap_notes,
      existing?.cap_notes ?? DEFAULT_CAP_NOTES[provider] ?? null,
    ),
    source,
  };

  getDb()
    .prepare(
      `INSERT INTO subscriptions
         (provider, plan_name, price_usd_month, renewal_day, cap_notes, source, updated_at)
       VALUES (@provider, @plan_name, @price_usd_month, @renewal_day,
               @cap_notes, @source, unixepoch())
       ON CONFLICT(provider) DO UPDATE SET
         plan_name = excluded.plan_name,
         price_usd_month = excluded.price_usd_month,
         renewal_day = excluded.renewal_day,
         cap_notes = excluded.cap_notes,
         source = excluded.source,
         updated_at = unixepoch()`,
    )
    .run(next);

  return { written: true, subscription: getSubscription(provider) };
}

export function deleteSubscription(provider: UsageProvider): boolean {
  return (
    getDb()
      .prepare(`DELETE FROM subscriptions WHERE provider = ?`)
      .run(provider).changes > 0
  );
}

function pick<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}
