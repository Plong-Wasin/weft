FROM node:22-bookworm-slim AS web-build
WORKDIR /workspace/apps/web
RUN corepack enable
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/web/ ./
RUN pnpm build

FROM rust:1-bookworm AS rust-build
WORKDIR /workspace
COPY Cargo.toml Cargo.lock ./
COPY crates/weft-server/Cargo.toml crates/weft-server/Cargo.toml
COPY crates/weft-server/src crates/weft-server/src
COPY crates/weft-server/migrations crates/weft-server/migrations
COPY crates/weft-cli/Cargo.toml crates/weft-cli/Cargo.toml
COPY crates/weft-cli/src crates/weft-cli/src
RUN cargo build --release -p weft-cli

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl git git-lfs postgresql-client \
    && git lfs install --system \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 weft \
    && useradd --system --uid 10001 --gid weft --home-dir /var/lib/weft --no-create-home weft \
    && mkdir -p /app/web /var/lib/weft/attachments /var/lib/weft/vaults \
    && chown -R weft:weft /app /var/lib/weft
COPY --from=rust-build /workspace/target/release/weft /usr/local/bin/weft
COPY --from=web-build /workspace/apps/web/dist/ /app/web/
ENV WEFT_LISTEN=0.0.0.0:8080 WEFT_WEB_ROOT=/app/web WEFT_DATA_DIR=/var/lib/weft
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["weft"]
CMD ["serve"]
