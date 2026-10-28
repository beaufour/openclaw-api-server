FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run check \
    && npm run build:server \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=10000:10000 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=10000:10000 /app/node_modules ./node_modules
COPY --from=build --chown=10000:10000 /app/dist-runtime ./dist-runtime

# The compiled service starts with node directly. npm/npx are build tools and
# their bundled dependency tree does not belong in this runtime image.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx

EXPOSE 18790

USER 10000:10000

CMD ["node", "dist-runtime/scripts/server.js"]
