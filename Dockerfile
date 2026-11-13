# One image for the Bun services (api, worker, migrate); a second target serves the built web app.
FROM oven/bun:1.4 AS base
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM base AS web-build
# Empty uses relative API URLs through the single-origin proxy; local compose keeps the direct API default.
ARG VITE_API_URL=http://localhost:3000
ARG VITE_LIVE_URL=ws://localhost:3002
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_LIVE_URL=$VITE_LIVE_URL
# The service worker must send bucket navigations to MinIO instead of the SPA shell.
ARG VITE_ASSET_PATH=weft-assets
ENV VITE_ASSET_PATH=$VITE_ASSET_PATH
RUN cd apps/web && bunx vite build

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80

FROM base AS server
ENV NODE_ENV=production
# The oven/bun image ships a non-root `bun` user; the services only read the code and never write under /app.
USER bun
EXPOSE 3000 3001 3002
CMD ["bun", "apps/api/src/index.ts"]
