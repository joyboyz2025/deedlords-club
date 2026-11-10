# Build từ thư mục gốc của dự án: docker build -f server/Dockerfile .
# Standalone deedlords: only the property game (Cờ tỷ phú) room. Opening rooms needs TOWN_DEV_AUTH=1 or SUPABASE_URL/SUPABASE_ANON_KEY.
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/
RUN cd server && npm install --omit=dev --no-audit --no-fund
# Cho cả thư mục gốc thấy các gói đã cài.
RUN ln -s server/node_modules node_modules
COPY server server
COPY worker worker
COPY lib lib
COPY games/co-ty-phu/board.ts games/co-ty-phu/engine.ts games/co-ty-phu/protocol.ts games/co-ty-phu/view.ts games/co-ty-phu/
COPY shared/board.json shared/
COPY games/ma-soi/look.ts games/ma-soi/
RUN mkdir /data && chown node /data
USER node
ENV PORT=8080 DATA_DIR=/data
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--import", "./server/register.mjs", "server/index.ts"]
