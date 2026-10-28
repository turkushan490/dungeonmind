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

# ---- runtime: CPU only, Kokoro narrator built in ----
FROM node:24-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=4830 DATA_DIR=/data WEB_DIR=/app/web RULES_DIR=/app/server/data CANVAS_DIR=/app/hivemind AUTH_MODE=builtin KOKORO_MODEL_DIR=/app/models
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY web/package.json web/
# ONNX Runtime ships every platform and the CUDA providers (~470 MB); this image is linux/amd64 CPU only.
RUN npm ci --omit=dev -w server && npm cache clean --force \
 && cd node_modules/onnxruntime-node/bin/napi-v3 && rm -rf darwin win32 linux/arm64 linux/x64/libonnxruntime_providers_cuda.so linux/x64/libonnxruntime_providers_tensorrt.so
COPY server/scripts ./server/scripts
RUN node server/scripts/fetch-kokoro.mjs || echo "Kokoro model not baked in: it downloads to /data/models on first use"
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web
COPY server/data ./server/data
COPY hivemind ./hivemind
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
VOLUME /data
EXPOSE 4830
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/main.js"]

# ---- full: adds Chatterbox (Python, CPU torch; GPU works with --gpus all) ----
FROM runtime AS full
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/chatterbox \
 && /opt/chatterbox/bin/pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
 && /opt/chatterbox/bin/pip install --no-cache-dir chatterbox-tts
COPY docker ./docker
ENV TTS_ENGINE=chatterbox
CMD ["/app/docker/start-full.sh"]
