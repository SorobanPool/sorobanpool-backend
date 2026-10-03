# sororail-backend

API server for the Sororail app: serves data to [sororail-frontend](https://github.com/Sororail/sororail-frontend), handles user auth, and persists application state in Postgres.

This repo previously held the SO4 oracle/keeper service; that code and its history now live on the [`legacy-oracle`](https://github.com/Sororail/sororail-backend/tree/legacy-oracle) branch.

## Running locally

```
cp .env.example .env
# set DATABASE_URL to a running Postgres instance
cargo run
```

Migrations run automatically on startup via `sqlx::migrate!`.

## Endpoints

- `GET /health` — liveness
- `GET /ready` — readiness (checks DB connectivity)
- `POST /auth/register` — create a user, returns a JWT
- `POST /auth/login` — authenticate, returns a JWT
