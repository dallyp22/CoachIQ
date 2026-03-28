FROM python:3.12-slim

WORKDIR /app

# Install uv for fast dependency management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy project files
COPY pyproject.toml uv.lock ./
COPY coachiq/ coachiq/

# Install dependencies
RUN uv sync --no-dev --frozen

# Create data directory for SQLite
RUN mkdir -p /app/data

# Expose port
EXPOSE 8080

# Cloud Run uses PORT env var (default 8080)
CMD ["uv", "run", "uvicorn", "coachiq.main:app", "--host", "0.0.0.0", "--port", "8080"]
