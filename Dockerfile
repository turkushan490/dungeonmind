# ---- build ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run typecheck && npm test && npm run build

# ---- runtime (CPU only) ----
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4830 DATA_DIR=/data WEB_DIR=/app/web RULES_DIR=/app/server/data AUTH_MODE=builtin
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web
COPY server/data ./server/data
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
VOLUME /data
EXPOSE 4830
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/main.js"]
