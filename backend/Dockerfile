FROM python:3.11-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Don't copy .env (secrets via env vars in deployment)
RUN rm -f .env

# Non-root user for security
RUN adduser --disabled-password --no-create-home appuser
USER appuser

EXPOSE ${PORT:-8000}

CMD uvicorn server:app --host 0.0.0.0 --port ${PORT:-8000}
