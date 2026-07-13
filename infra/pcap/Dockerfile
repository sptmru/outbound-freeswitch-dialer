FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json

RUN npm ci

COPY packages packages
COPY apps/api apps/api

RUN npm run build --workspace @outbound-dialer/shared
RUN npm run build --workspace @outbound-dialer/api

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tcpdump \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/apps/api/dist/pcap-capture-server.js /app/pcap-capture-server.js
COPY --chmod=0755 infra/pcap/entrypoint.sh /usr/local/bin/pcap-entrypoint

ENTRYPOINT ["/usr/local/bin/pcap-entrypoint"]
CMD ["node", "/app/pcap-capture-server.js"]
