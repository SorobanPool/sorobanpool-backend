# Runbook: contract TTL (ttl-extend)

Contract instances and wasm code are not extended by contract calls (contracts ADR 0005). The `ttl-extend` job (`startTtlKeeper`, hourly) extends each contract's instance and code with `ExtendFootprintTtl` when under ~20 days remain.

- **Log `ttl-extend ALERT entries not found`**: an instance or code entry is missing from the RPC (archived or a wrong wasm hash in `deployments/*.json`). Restore it with a `RestoreFootprint` transaction, then check the deployment file. Treat as a page.
- **Cost**: extending code is real rent, paid by the sponsor, once per ~40 days per contract. On testnet it measured ~35 XLM for `config` and ~120 XLM for `group_buy`; confirm mainnet rates before pricing, and include it in the sponsor-balance alert.
- Manual run: call `chain.keepAlive()` from a script; a second call immediately after should extend nothing.
