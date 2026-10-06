# 0004 Database tests run on PGlite

**Context.** No Docker/Postgres is available in all dev and CI environments, but repositories, transactions and BigInt/Decimal handling need real Postgres semantics.

**Decision.** `test/pg.ts` boots PGlite, applies the committed migration SQL, serves it over the Postgres wire protocol and connects Prisma (`@prisma/adapter-pg`). Specs exercise stores, the atomic projector, the API and the keeper against the real schema.

**Consequences.** Fast, hermetic tests. PGlite is not production Postgres; CI also runs the whole suite against a real PostgreSQL 16 service container (`TEST_DATABASE_URL`, job `real-postgres`), which proves the migrations apply there. Redis and MinIO are not part of any test.
