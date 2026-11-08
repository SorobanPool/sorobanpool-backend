# 0006 Verification (KYC / KYB) behind a provider port, sandbox first

**Context.** Brief 7.8 asks for a provider adapter (`verifyBvn`, `verifyNin`, `liveness`, `faceMatch`, `verifyCac`,
`verifyBankAccountName`), with Smile ID, Dojah and Prembly as candidates. Picking one needs commercial terms, a data
processing agreement and an NDPA review (brief 13.3, 13.7): not an engineering decision. Until now the only
verification path was an admin typing a level.

**Decision.**
- `src/verification/provider.ts` defines `VerificationProvider`. `SandboxVerificationProvider` is deterministic with
  documented magic values so every branch can be exercised in tests and staging demos. `KYC_PROVIDER=sandbox` is
  refused when `NODE_ENV=production`, and any provider without an adapter fails closed at startup.
- `POST /kyc/start` (BVN or NIN + claimed name and date of birth + selfie hash): identity lookup, then liveness, then
  face match. All three must pass. `GET /kyc/status` returns the state with the identifier masked.
- Supplier applications run `verifyCac` and, when bank details are given, `verifyBankAccountName` against the business
  and director names. The results are shown to the reviewer (`GET /admin/suppliers -> kybChecks`); an admin still
  decides after the manual address review.
- Provider results, identifiers and bank numbers are stored only inside `VerificationRecord.result`, sealed with
  AES-256-GCM (`src/common/pii.ts`, key from `ENCRYPTION_KEY_ID`). Profiles keep masked values only.
- `src/verification/attestor.ts` is the single path to `registry.attest`, for admin reviews and KYC alike:
  `ver_hash = sha256(userId | providerRef | level | salt)` with a random salt kept in the sealed record, a daily cap
  (`ATTESTOR_DAILY_CAP`, default 500) and an alert at 80% of it. Above the cap it refuses rather than queueing.

**Consequences.** Adding a real provider means one class implementing the port plus record/replay fixtures for its
API (brief 11.2). Key rotation needs re-sealing records (store a key version when a KMS is wired in). Selfies are
referenced by hash; the provider fetch through a short-lived signed URL is part of the real adapter.
