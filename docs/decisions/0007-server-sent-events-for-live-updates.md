# 0007 Live pool updates over Server-Sent Events, not WebSocket

**Context.** Brief 7.4 names "WebSocket channel per pool ... and per user" for realtime progress. Every realtime need
in the product is one-way, server to phone: units committed, tier reached, state changes. Clients act through the
REST prepare/submit endpoints, never over the live channel. Traders are on patchy 3G behind carrier proxies.

**Decision.** `GET /v1/pools/:id/stream` is a Server-Sent Events stream (`PoolStreamController`), fed by the indexer
as events are projected. The frontend (`lib/pool-stream.ts`) uses `EventSource` and falls back to polling every 15 s.

**Why not WebSocket.** SSE is plain HTTP: it passes through carrier proxies and CDNs that break upgrades, needs no
extra auth handshake (pool progress is public, like the share page), reconnects automatically with `Last-Event-ID`,
and costs no client library (the JS budget on trader pages is 170 KB, ADR 0002 of the frontend). A bidirectional
socket would add a second auth path and a second protocol with nothing to carry upstream.

**Consequences.** Per-user channels (brief 7.4) are covered by SMS and polling today. If a per-user live channel is
added it should also be SSE, authenticated with the access token. Horizontal scaling needs a shared fan-out
(Redis pub/sub) once the API runs more than one replica, the same constraint as the rate limiter.
