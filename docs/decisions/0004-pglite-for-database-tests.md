# 0004 Database tests run on PGlite

**Context.** No Docker/Postgres is available in all dev and CI environments, but repositories, transactions and BigInt/Decimal handling need real Postgres semantics.

**Decision.** `test/pg.ts` boots PGlite, applies the committed migration SQL, serves it over the Postgres wire protocol and connects Prisma (`@prisma/adapter-pg`). Specs exercise stores, the atomic projector, the API and the keeper against the real schema.

**Consequences.** Fast, hermetic tests. PGlite is not production Postgres; Testcontainers (Postgres 16, Redis, MinIO) remain a CI addition once Docker is available.
