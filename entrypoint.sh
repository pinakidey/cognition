#!/bin/sh
# Fix volume permissions — Fly.io mounts volumes as root,
# but our app runs as non-root (appuser uid=1000).
# This script runs as root, fixes ownership, then drops to appuser.

DATA_DIR="/data"
APP_USER="appuser"

# Ensure data directory is writable by appuser
if [ -d "$DATA_DIR" ]; then
    chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
fi

# Drop privileges and start the app
exec su -s /bin/sh "$APP_USER" -c "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"
