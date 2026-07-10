# 0003 Wallets in M2: bound classic accounts; passkey smart wallets pending

> **Superseded (November 2026)** by contracts ADR 0006: users get a passkey smart wallet through `POST /wallets/passkey`. Classic device-key binding (`POST /wallets`) remains as a testnet fallback for browsers without WebAuthn.

**Context.** Brief open question 1: passkey smart wallet versus MPC. A passkey wallet SDK and its audit status are not yet chosen.

**Decision.** Users bind a Stellar G-account after proving possession (ed25519 signature over a server challenge). `POST /wallets` rejects contract addresses with `SMART_WALLET_UNSUPPORTED`. The prepare/submit flow is wallet-agnostic: a passkey signer only has to produce the same authorization-entry signature.

**Consequences.** Classic accounts must exist on-chain (the host loads the account to check signers), which is why the testnet harness funds test users through friendbot. That is a harness detail, not the product flow. Production needs the passkey wallet ADR before launch.
