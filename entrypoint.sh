#!/bin/sh
# Start the Next.js dashboard and the Ollama proxy in parallel.
# If either process dies, restart it after a short delay.

start_server() {
  while true; do
    echo "[entrypoint] Starting Next.js server..."
    node server.js
    echo "[entrypoint] Next.js server exited ($?), restarting in 2s..."
    sleep 2
  done
}

start_proxy() {
  while true; do
    echo "[entrypoint] Starting Ollama proxy..."
    node proxy.js
    echo "[entrypoint] Ollama proxy exited ($?), restarting in 2s..."
    sleep 2
  done
}

# Run migrations ONCE, before either long-running process starts. This replaces
# the old design where both processes called migrate() in parallel and raced.
echo "[entrypoint] Running database migrations..."
if ! node migrate.js; then
  echo "[entrypoint] Migration failed; refusing to start. Exiting."
  exit 1
fi

start_server &
start_proxy &

# Wait for all background jobs; if the container receives SIGTERM,
# the shell forwards it and both loops exit.
wait
