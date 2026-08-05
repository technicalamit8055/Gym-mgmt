import { run } from './db.js';

/**
 * Flips memberships whose end date has passed to "expired". Cheap enough to run
 * before any read that reports on membership state, which keeps the numbers
 * honest without a background scheduler.
 */
export function expireOverdueSubscriptions() {
  return run(
    "UPDATE subscriptions SET status = 'expired' WHERE status = 'active' AND end_date < date('now')",
  ).changes;
}
