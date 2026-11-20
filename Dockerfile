# syntax=docker/dockerfile:1

# ---------- 1. build：只在建置階段存在，不會進到最終映像 ----------
FROM node:20-alpine AS build
WORKDIR /app

# 依賴層單獨快取：只改 src/ 時不用重跑 npm ci
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# npm run build = 產生 PWA icon → tsc --noEmit → vite build
RUN npm run build


# ---------- 2. runtime：靜態檔案由 nginx 提供 ----------
FROM nginx:1.27-alpine AS runtime

RUN rm -f /etc/nginx/conf.d/default.conf
COPY deploy/nginx.conf /etc/nginx/conf.d/triplog.conf
COPY deploy/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html

# 8080 而非 80：換成 nginx-unprivileged 映像也不用改設定
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1
