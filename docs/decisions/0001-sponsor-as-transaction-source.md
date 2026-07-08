# 0001 Fee sponsorship: the sponsor is the transaction source

**Context.** Users must never hold XLM. The brief suggests fee-bumping a user-signed transaction. With passkey or contract wallets the user has no classic account to be the transaction source, and Soroban only needs the user to sign *authorization entries*.

**Decision.** The sponsor account is the transaction source and pays all fees. The client signs only Soroban authorization entries returned by `prepare`; `POST /tx/submit` re-simulates, signs as sponsor and submits. `feeBump` is kept for wallets that sign whole transactions.

**Safety.** The sponsor's own authority must never be lendable: `inspectUserTx` refuses source-account credentials, delegated credentials, entries for any account but the caller's bound wallet, entries that do not match the invoked function, multi-operation transactions and fees above 5 XLM. Contract function allow-list and per-user daily caps apply before any fee is spent.

**Consequences.** One sequence-number stream per sponsor account (serialised by a mutex); scale-out needs several channel accounts. Verified live on testnet, including `AddressV2` credentials.
