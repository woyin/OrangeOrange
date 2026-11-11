FROM node:24.14.1-bookworm-slim AS web-build
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build
FROM node:24.14.1-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm_config_nodedir=/usr/local npm ci --fetch-timeout=30000 --fetch-retries=1
COPY tsconfig*.json ./
COPY src ./src
COPY tests ./tests
COPY docs/openapi.json ./docs/openapi.json
COPY vitest.config.ts ./
COPY prompts ./prompts
COPY skills ./skills
COPY scripts ./scripts
FROM build AS probe
USER node
CMD ["npm", "test", "--", "tests/recovery.test.ts", "tests/ownership.test.ts", "tests/tools.test.ts", "tests/gateway.test.ts"]
FROM build AS compiled
RUN npm run build:server && npm prune --omit=dev
FROM node:24.14.1-bookworm-slim AS runtime
RUN apt-get update && apt-get upgrade -y && apt-get clean && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production HDA_DATA_DIR=/data HDA_WORKSPACE=/workspace HDA_HOST=0.0.0.0 HDA_PORT=8787 HDA_WEB_DIR=/app/apps/web/dist
WORKDIR /app
COPY --from=compiled /app/node_modules ./node_modules
COPY --from=compiled /app/dist ./dist
COPY package.json ./
COPY prompts ./prompts
COPY skills ./skills
COPY --from=web-build /web/dist ./apps/web/dist
RUN mkdir -p /data /workspace && chown node:node /data /workspace
USER node
EXPOSE 8787
VOLUME ["/data", "/workspace"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/control/main.js"]
