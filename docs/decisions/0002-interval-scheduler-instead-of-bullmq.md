# 0002 Interval scheduler for keeper and indexer (BullMQ deferred)

**Context.** The brief specifies BullMQ for workers. There is no Redis in the current dev environment, and every keeper action is idempotent: the contract re-checks every condition, so a duplicate or early call is refused harmlessly.

**Decision.** `ROLE=worker|indexer` run simple non-overlapping interval loops (`src/workers/runners.ts`). Run one worker instance.

**Consequences.** No distributed scheduling or retry queue yet: two workers would double-send (harmless but wasteful). Move to BullMQ repeatable jobs before running more than one instance or when delayed retries are needed.
