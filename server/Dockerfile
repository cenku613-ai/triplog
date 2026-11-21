# 後端映像：零依賴，只要 Node 24（用內建的 node:http + node:sqlite）。
# 合併邏輯和前端共用同一份 src/lib/merge-core.js，所以 build context 是整個 repo，
# 但只 COPY 需要的三個檔——不進 image 的就不會被讀到，也減小攻擊面。
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    TRIPLOG_DATA_DIR=/data

COPY src/lib/merge-core.js ./src/lib/merge-core.js
COPY server/package.json ./server/package.json
COPY server/src ./server/src

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=4s --start-period=6s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
