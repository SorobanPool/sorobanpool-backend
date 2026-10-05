# 0005 Naira rails: AnchorProvider abstraction with a mock until section 17 is decided

**Context.** Brief section 17 leaves open which NGN anchor to use, whether it supports contract accounts (SEP-24/SEP-6, SEP-10 vs SEP-45), fees, limits and the Nigerian licensing structure. None of that can be verified without a real anchor and legal input.

**Decision.** `src/anchor/anchor.ts` defines `AnchorProvider`. The only implementation is `MockAnchor` (a fake bank): `POST /anchor/deposit/start` returns payment instructions and an indicative USDC estimate; the final USDC is computed from the rate **when the bank transfer is confirmed** (brief 7.10: "anchor rate at payment is final"); confirmation is idempotent and never pays twice. USDC is paid through `ChainService.payUsdc`, inside the same lock as fee sponsorship (same account, same sequence numbers). The mock and the dev confirm endpoint exist only off mainnet and outside production; elsewhere the endpoints answer 501.

**Consequences.** The deposit flow, limits, status polling and UI can be built and tested now. Withdrawals/payouts to bank (suppliers, organizers, refunds) are not implemented. Replacing the mock means writing a SEP-24 provider and a webhook/poller; the controller and tables stay.
