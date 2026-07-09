# Runbook: notifications and maintenance jobs

All jobs log failures with a `[name]` prefix; `ALERT` lines should page someone.

## Notifier (every 30s)
Sends queued SMS from the `Notification` table. Messages are rendered in the member's language (EN or Pidgin) and must fit one 160-character SMS. Quiet hours (21:00-07:00 WAT) defer everything except `dispatched` and `ready_for_pickup`. A failed send backs off 2, 4, 8, 16 minutes and is then marked `FAILED` after 5 attempts.
- Many `FAILED` rows (`sp_notifications_failed` on `/v1/metrics`): the SMS provider is down or rejecting; check `lastError`. Fix, then reset: `UPDATE "Notification" SET status='PENDING', attempts=0, "runAfter"=now() WHERE status='FAILED' AND "createdAt" > now() - interval '1 day';`
- Growing `sp_notifications_pending`: the notifier is not running (check the worker role) or the provider is slow.
- Delivery is at-most-once per chain event: if the process dies between the indexer committing an event and queueing its SMS, that message is lost. Deadline reminders are claimed in the database and are not lost.
- The default sender only prints to the console. Production needs a real `SmsSender` (provider decision pending).

## Maintenance (every 5 minutes)
- **Offer expiry**: `LIVE` offers past `validUntil` become `EXPIRED`. Pools already created from them are unaffected.
- **Deadline reminders**: one SMS per member when an open pool is within 24h of its deadline and still below MOQ. Marked once per pool (`deadlineRemindedAt`).
- **Sponsor balance**: `ALERT sponsor balance ... below SPONSOR_MIN_XLM`. The sponsor pays every user's fee; when it is empty the product stops. Top it up; see also the TTL cost note in `ttl-extend.md`.
- **Reconcile**: compares up to 50 live pools' state, units and escrow with the chain. `ALERT pool N field: db=... chain=...` fires only when the same difference is seen on two consecutive runs (indexer lag is normal for a few seconds). The chain is the truth: check indexer lag and `[indexer]` errors, then re-run the indexer from before that pool's last event (events are idempotent).

## Run one worker replica
The scheduler is in-process (ADR 0002). Two worker replicas would both send keeper transactions and notifications; the chain tolerates the former (it re-checks every condition) but the notifier does not coordinate. Scale out only after moving to a queue.
