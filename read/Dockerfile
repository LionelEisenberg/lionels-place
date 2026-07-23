# ---------- Stage 1: build (Node — encrypts <private> blocks, emits dist/) ----------
FROM node:20-alpine AS builder
WORKDIR /src

# Install deps first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY crypto-utils.mjs build.js ./
COPY bin ./bin
COPY assets ./assets
COPY style.css decrypt.js index.html ./
COPY blog-posts ./blog-posts

RUN node bin/build.mjs

# ---------- Stage 2: serve (Python — FastAPI serves dist + /api routes) ----------
FROM python:3.12-slim AS serve
WORKDIR /app

# System deps for SQLite (slim image already has it, but be explicit)
RUN pip install --no-cache-dir \
        "fastapi>=0.115" \
        "uvicorn[standard]>=0.30" \
        "sqlalchemy>=2.0" \
        "pydantic>=2.0"

# Backend source
COPY backend ./backend

# Built static assets from stage 1
COPY --from=builder /src/dist /app/dist

# Data dir for SQLite (volume-mounted at runtime)
RUN mkdir -p /app/data

ENV READ_DATA_DIR=/app/data \
    READ_DIST_DIR=/app/dist

EXPOSE 80

CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "80"]
