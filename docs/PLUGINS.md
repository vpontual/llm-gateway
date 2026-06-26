# Plugin System

LLM Gateway supports a plugin architecture for extending functionality. Plugins live in the `plugins/` directory and are loaded at startup.

## Plugin Types

### Agent (supported)

An **agent** plugin is an external process running on remote servers. The poller collects data from agent endpoints on each poll cycle.

Example: `fleet-metrics`, a Python service that exposes system metrics (CPU/GPU temp, memory, disk, uptime) over HTTP.

### Hook (coming soon)

A **hook** plugin is a TypeScript module loaded in-process that hooks into poller lifecycle events.

## Creating a Plugin

1. Create a directory under `plugins/` with your plugin name
2. Add a `plugin.json` manifest
3. Include your plugin code and a README

### Manifest Format

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "type": "agent",
  "defaultPort": 9100,
  "endpoint": "/metrics",
  "configKey": "metricsPort"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Plugin identifier (matches directory name) |
| `version` | Yes | Semver version string |
| `description` | Yes | Short description |
| `type` | Yes | `"agent"` or `"hook"` |
| `defaultPort` | Agent only | Default port the agent listens on |
| `endpoint` | Agent only | HTTP path to fetch data from |
| `configKey` | No | Field name added to server config for per-server port override |

### Per-Server Configuration

If your plugin defines a `configKey`, users can override the default port per server in `OLLAMA_SERVERS`:

```json
[
  {"name": "Server 1", "host": "192.168.1.100:11434", "ramGb": 16, "metricsPort": 9100},
  {"name": "Server 2", "host": "192.168.1.101:11434", "ramGb": 24, "metricsPort": 0}
]
```

Setting the port to `0` or `null` disables the plugin for that server.

## API

`GET /api/plugins` returns the list of installed plugins and their manifests.

## Reference: fleet-metrics

The `fleet-metrics` plugin is the first official plugin. See [`plugins/fleet-metrics/README.md`](plugins/fleet-metrics/README.md) for setup instructions.

Directory structure:
```
plugins/fleet-metrics/
  plugin.json          # Plugin manifest
  fleet_metrics.py     # Python agent (runs on each server)
  fleet-metrics.service # systemd unit file
  README.md            # Setup guide
```
