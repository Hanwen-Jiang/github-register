# Playwright 注册容器 — GitHub OAuth → cun.ai / a6api
FROM node:20-slim

# Chromium 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
    libdrm2 libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Playwright
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN npx playwright install chromium --with-deps

# 项目文件；运行时通过 --env-file .env 或环境变量注入敏感配置。
COPY . ./

# sing-box (从本地复制或下载)
# 如果 sing-box 在项目目录中，COPY 进来；否则运行时通过 volume 挂载

# Chromium 数据目录 (持久化 profile)
VOLUME /app/.chrome-profile /app/.browsers

ENV HEADLESS=true
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.browsers
ENV NODE_ENV=production

CMD ["node", "index.js"]
