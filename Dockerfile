FROM oven/bun:1.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.2-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
RUN mkdir -p /app/.data && chown -R bun:bun /app
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
