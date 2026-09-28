# Gulpy, as one process with one SQLite file.
# Mount a disk at /data. Set GULPY_BASE_URL, GULPY_MASTER_KEY, RESEND_API_KEY and MAIL_FROM.
FROM oven/bun:1.3.11-slim

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    GULPY_DB=/data/gulpy.db

# The host mounts the disk at /data. Railway does not permit the VOLUME keyword.
RUN mkdir -p /data
EXPOSE 8080

CMD ["bun", "run", "src/main.ts"]
