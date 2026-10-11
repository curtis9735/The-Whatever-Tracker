# syntax=docker/dockerfile:1

# ---- Build the app once, on the CI runner's native CPU -------------------------------
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: native modules (better-sqlite3, sharp) use bundled prebuilt binaries,
# so npm must not attempt its implicit node-gyp compile
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

# ---- Production dependencies for the *target* CPU (amd64 or arm64) --------------------
# better-sqlite3 and sharp ship prebuilt glibc binaries for both, so nothing compiles here.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
	&& node -e "new (require('better-sqlite3'))(':memory:'); require('sharp'); console.log('native modules OK')"

# ---- Runtime --------------------------------------------------------------------------
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
	PORT=3000 \
	DATA_DIR=/data \
	MIGRATIONS_DIR=/app/drizzle \
	BODY_SIZE_LIMIT=25M
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./
# /data is meant to be a bind mount; the default owner matches the image's "node" user
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build"]
