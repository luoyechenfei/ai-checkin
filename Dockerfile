FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# 可通过 --build-arg NPM_REGISTRY=https://registry.npmmirror.com 加速国内构建
ARG NPM_REGISTRY=https://registry.npmjs.org

COPY package.json ./
RUN npm config set registry "$NPM_REGISTRY" \
    && npm install --omit=dev --no-audit --no-fund

COPY app ./app

# 数据持久化目录（SQLite 数据库文件）
VOLUME ["/app/data"]

# 内部端口，可通过环境变量 INTERNAL_PORT 修改
ENV INTERNAL_PORT=3000
EXPOSE 3000

CMD ["node", "app/server.js"]
