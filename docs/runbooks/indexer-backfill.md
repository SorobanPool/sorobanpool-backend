# Runbook: indexer start and backfill

Soroban RPC keeps contract events only for a limited window (about 7 days on testnet; check `getHealth.oldestLedger`).
The indexer reads events from RPC, so anything older than the window cannot be fetched from RPC.

## Fresh install
With no row in `IndexerCursor` and `INDEXER_START_LEDGER` unset, the indexer starts
`RETENTION_MARGIN_LEDGERS` (60, about 5 minutes) inside the retention window and logs:

```
[indexer] no cursor yet: starting near the oldest retained ledger (N, oldest M); earlier events, if any, need a backfill
```

The margin exists because the window slides forward while the first request is in flight.
While catching up, `indexer_lag_ledgers` is high and the lag alert fires; it clears once the cursor reaches the tip
(1,000 ledgers per tick).

## Explicit start
`INDEXER_START_LEDGER=<ledger>` is honoured strictly. If it is older than the retention window the indexer refuses
to run (`behind the RPC event retention window`) rather than skip history. Use it when you know the deploy ledger of
the contracts and it is still retained.

## Behind retention (cursor exists)
If the indexer was down longer than the window, every tick fails with `backfill required` and the alert fires.
Events between the cursor and `oldestLedger` must come from an archive source:

1. Export the missing ledger range from a full-history source (a Galexie / ledger-metadata data lake, or a
   Hubble/BigQuery export of `history_contract_events`) filtered to the contract IDs in `DEPLOYMENTS_FILE`.
2. Insert them into `ChainEvent` (the table is idempotent by event id) and replay them through the projector.
3. Set `IndexerCursor.lastLedger` to the last ledger you imported, inside the retention window, and restart.
4. Run the `reconcile` job and confirm there is no escrow mismatch.

Read models are rebuildable from `ChainEvent` at any time (brief 7.3), so a bad projection can be fixed by truncating
the read-model tables and replaying.
