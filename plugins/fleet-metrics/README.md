# Fleet Metrics Agent

A lightweight Python agent that exposes system metrics over HTTP for the LLM Gateway dashboard.

Install this on each Ollama server you want to monitor for CPU/GPU temperature, memory, disk, and uptime.

## Requirements

- Python 3.8+
- No external dependencies (uses only the standard library)

## Install

```bash
# Copy the agent to each Ollama server
sudo mkdir -p /opt/fleet-metrics
sudo cp fleet_metrics.py /opt/fleet-metrics/

# Install the systemd service
sudo cp fleet-metrics.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fleet-metrics
```

## Verify

```bash
curl http://localhost:9100/metrics
```

You should see a JSON response with hostname, temperatures, memory, disk, load, and uptime.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9100` | HTTP port to listen on |

Set the port in the systemd service file if needed:

```ini
Environment=PORT=9100
```

## GPU Support

- **NVIDIA GPUs** (desktop/server): Uses `nvidia-smi` automatically
- **Jetson devices**: Reads from sysfs thermal zones and GPU load files
- If no GPU is detected, GPU metrics are reported as `null`

## Update

```bash
sudo cp fleet_metrics.py /opt/fleet-metrics/
sudo systemctl restart fleet-metrics
```
