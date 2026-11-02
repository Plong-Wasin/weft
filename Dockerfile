# One image for the Bun services (api, worker, migrate); a second target serves the built web app.
FROM oven/bun:1.4 AS base
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM base AS web-build
# The browser calls the API and live WebSocket directly, so their public URLs are baked into the bundle.
ARG VITE_API_URL=http://localhost:3000
ARG VITE_LIVE_URL=ws://localhost:3002
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_LIVE_URL=$VITE_LIVE_URL
RUN cd apps/web && bunx vite build

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80

FROM base AS server
ENV NODE_ENV=production
EXPOSE 3000 3001 3002
CMD ["bun", "apps/api/src/index.ts"]
