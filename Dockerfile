FROM rust:1.82 AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/sororail-backend /usr/local/bin/sororail-backend
EXPOSE 8080
HEALTHCHECK CMD curl -f http://localhost:8080/ready || exit 1
CMD ["sororail-backend"]
