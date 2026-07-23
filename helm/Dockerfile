# ==========================================
# Stage 1: Build React Frontend
# ==========================================
FROM node:20-alpine AS frontend-build

WORKDIR /frontend

# Install dependencies first (layer caching)
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

# Build the React app
COPY frontend/ ./
RUN npm run build

# ==========================================
# Stage 2: Python Runtime
# ==========================================
FROM python:3.11-slim

WORKDIR /app

# Install Python dependencies — runtime plus test deps, so the pre-commit
# hook can run the backend suite inside this container.
COPY backend/requirements.txt backend/requirements-test.txt ./
RUN pip install --no-cache-dir -r requirements.txt -r requirements-test.txt

# Copy backend source
COPY backend/ ./backend/

# Copy habits config
COPY habits_config.json ./

# Copy built frontend from stage 1
COPY --from=frontend-build /frontend/dist ./dist/

# Create data and import directories
RUN mkdir -p /app/data /app/import

EXPOSE 8001

CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8001"]
