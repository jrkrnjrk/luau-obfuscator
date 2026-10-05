FROM node:22-bookworm-slim AS build

WORKDIR /app

# tree-sitter ships glibc prebuilds; the toolchain covers a missing prebuild.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY --from=build /app /app

EXPOSE 3001
CMD ["node", "server/index.js"]
