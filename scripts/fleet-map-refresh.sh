#!/usr/bin/env bash
set -euo pipefail
cd /home/vp/ollama_proxy
DBURL=$(grep -E '^DATABASE_URL' .env | cut -d= -f2- | sed 's#@db:5432#@localhost:5434#')
DATABASE_URL="$DBURL" node scripts/fleet-map.mjs > /home/vp/infra-inventory/roadmap/fleet-map.md
cd /home/vp/infra-inventory
git add roadmap/fleet-map.md
git diff --cached --quiet || git -c user.name=vp -c user.email=veepee@duck.com commit -q -m "chore: auto-refresh fleet-map ($(date -u +%FT%TZ))"
