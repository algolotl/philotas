# SPDX-License-Identifier: Apache-2.0
# Philotas object-detection service container.
#
# Build context: ./detect
# The service defaults to a trained AutoGluon model (mount it at /models and set
# AG_MODEL_DIR=/models). ultralytics YOLO is an explicit opt-in
# (DETECT_ENGINE=ultralytics) — see detect/README.md.

FROM python:3.13-slim

WORKDIR /app

# Install the base detection-service dependencies. AutoGluon and ultralytics
# are opt-in engines: install whichever you use (see detect/requirements.txt).
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY service.py train.py ./

# Run as a non-root user.
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8770
ENV DETECTION_PORT=8770
CMD ["uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8770"]
