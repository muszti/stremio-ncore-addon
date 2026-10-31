FROM golang:1.24-alpine AS go-build
WORKDIR /app
COPY torrent-server/go.mod ./go.mod
COPY torrent-server/go.sum ./go.sum
RUN go mod download
COPY ./torrent-server ./
RUN CGO_ENABLED=0 GOOS=linux go build -o ./

FROM node:20.16.0-alpine AS node-base
WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc pnpm-workspace.yaml ./
COPY ./patches ./patches
COPY ./server/package.json ./server/package.json
COPY ./client/package.json ./client/package.json


FROM node-base AS build-base
RUN corepack enable && corepack prepare pnpm@9.12.2 --activate

FROM build-base AS prod-deps
RUN pnpm install --prod --frozen-lockfile

FROM build-base AS build-deps
RUN pnpm install --frozen-lockfile

FROM build-deps AS build
COPY . .
RUN pnpm run build:server
RUN pnpm run build:client

FROM node-base AS runtime
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=go-build /app/torrent-server ./dist/torrent-server/torrent-server

ENV NODE_ENV="production"
ENV GIN_MODE="release"
ENV ADDON_DIR="/addon"
EXPOSE 3000 3443

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- -T 5 http://localhost:${TORRENT_SERVER_PORT:-8080}/torrents >/dev/null || exit 1

CMD ["node", "dist/server/index.js"]
