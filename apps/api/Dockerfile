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
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg util-linux \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --omit=dev

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/db apps/api/db
COPY infra/freeswitch/templates/inbound infra/freeswitch/templates/inbound
COPY infra/freeswitch/templates/dialplan/inbound-wait.xml.tpl infra/freeswitch/templates/dialplan/inbound-wait.xml.tpl

EXPOSE 3000
CMD ["npm", "--workspace", "@outbound-dialer/api", "run", "start"]
