#!/usr/bin/env python3
# DEPLOYED VERSION (what /opt/fleet-metrics/fleet_metrics.py runs on the DGX, Orin AGX and both
# Jetsons, md5 83bab972 before the 2026-10-01 nvidia-smi patch). It differs from fleet_metrics.py
# beside it; this copy exists so the code that actually runs is versioned. Reconcile before redeploying.
"""Ultra-lightweight system metrics agent for Ollama fleet monitoring.
Reads procfs/sysfs on demand — zero overhead when idle (~8MB RSS).
"""

import json
import os
import re
import socket
import subprocess
import time
from datetime import datetime, timezone, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 9100

# Cache boot history for 60s to avoid repeated subprocess calls
_boot_cache = {"data": [], "expires": 0}
# Cache reboot causes for 120s (heavier parsing)
_cause_cache = {"data": {}, "expires": 0}


def read_file(path):
    try:
        with open(path, "rb") as f:
            raw = f.read()
            if raw is None:
                return None
            return raw.decode("utf-8", errors="ignore").strip() or None
    except (OSError, IOError, TypeError):
        return None


def get_temperatures():
    temps = {}
    base = "/sys/class/thermal"
    try:
        zones = sorted(d for d in os.listdir(base) if d.startswith("thermal_zone"))
    except OSError:
        return temps
    for zone in zones:
        zone_type = read_file(os.path.join(base, zone, "type"))
        temp_raw = read_file(os.path.join(base, zone, "temp"))
        if zone_type and temp_raw:
            try:
                temp_c = int(temp_raw) / 1000.0
            except ValueError:
                continue
            # Map common Jetson/Orin thermal zone names
            key = zone_type.lower().replace("-thermal", "").replace("-therm", "")
            if key not in temps:  # keep first match per name
                temps[key] = round(temp_c, 1)
    # GPUs with no thermal zone (DGX Spark / GB10): ask nvidia-smi. Added 2026-10-01;
    # same fallback as the repo's plugins/fleet-metrics agent. Never fails the request.
    if not any(k.startswith("gpu") for k in temps):
        try:
            import subprocess
            out = subprocess.run(["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=3)
            if out.returncode == 0:
                for i, line in enumerate(out.stdout.strip().splitlines()):
                    if line.strip():
                        temps[f"gpu{i}"] = round(float(line.strip()), 1)
        except Exception:
            pass
    return temps


def get_memory():
    info = {}
    raw = read_file("/proc/meminfo")
    if not raw:
        return info
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            info[parts[0].rstrip(":")] = int(parts[1])  # in kB
    total = info.get("MemTotal", 0)
    available = info.get("MemAvailable", 0)
    swap_total = info.get("SwapTotal", 0)
    swap_free = info.get("SwapFree", 0)
    return {
        "total_mb": total // 1024,
        "used_mb": (total - available) // 1024,
        "available_mb": available // 1024,
        "swap_total_mb": swap_total // 1024,
        "swap_used_mb": (swap_total - swap_free) // 1024,
    }


def get_uptime():
    raw = read_file("/proc/uptime")
    if not raw:
        return 0
    return int(float(raw.split()[0]))


def get_load():
    raw = read_file("/proc/loadavg")
    if not raw:
        return [0, 0, 0]
    parts = raw.split()
    return [float(parts[0]), float(parts[1]), float(parts[2])]


def get_disk():
    try:
        st = os.statvfs("/")
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        used = total - free
        return {
            "total_gb": round(total / (1024 ** 3)),
            "used_gb": round(used / (1024 ** 3)),
            "free_gb": round(free / (1024 ** 3)),
        }
    except OSError:
        return {"total_gb": 0, "used_gb": 0, "free_gb": 0}


def get_recent_boots():
    now = time.time()
    if _boot_cache["expires"] > now:
        return _boot_cache["data"]
    boots = []
    try:
        out = subprocess.check_output(
            ["last", "reboot", "-F", "--time-format", "iso"],
            timeout=5, stderr=subprocess.DEVNULL
        ).decode()
        for line in out.splitlines():
            if line.startswith("reboot"):
                # Extract ISO timestamp from the line
                parts = line.split()
                for p in parts:
                    if p.startswith("20") and "T" in p:
                        boots.append(p)
                        break
    except Exception:
        # Fallback: parse non-iso format
        try:
            out = subprocess.check_output(
                ["last", "reboot", "-F"],
                timeout=5, stderr=subprocess.DEVNULL
            ).decode()
            for line in out.splitlines():
                if line.startswith("reboot"):
                    parts = line.split()
                    for i, p in enumerate(parts):
                        if p in ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"):
                            date_str = " ".join(parts[i:i+5])
                            try:
                                dt = datetime.strptime(date_str, "%a %b %d %H:%M:%S %Y")
                                boots.append(dt.replace(tzinfo=timezone.utc).isoformat())
                            except ValueError:
                                pass
                            break
        except Exception:
            pass
    boots = boots[:10]
    _boot_cache["data"] = boots
    _boot_cache["expires"] = now + 60
    return boots


def _read_auth_log():
    """Read auth.log, trying common paths. Returns lines or empty list."""
    for path in ["/var/log/auth.log", "/var/log/secure"]:
        try:
            with open(path, "r", errors="ignore") as f:
                return f.readlines()
        except (OSError, PermissionError):
            continue
    return []


def _read_syslog():
    """Read syslog for power button events. Returns lines or empty list."""
    for path in ["/var/log/syslog", "/var/log/messages"]:
        try:
            with open(path, "r", errors="ignore") as f:
                return f.readlines()
        except (OSError, PermissionError):
            continue
    return []


def _parse_log_timestamp(line):
    """Try to parse a timestamp from an auth.log or syslog line.
    Handles both traditional (Feb 14 21:05:08) and ISO (2026-02-14T21:05:08) formats.
    Returns a datetime or None.
    """
    # ISO format: 2026-02-14T21:05:08.558449-05:00
    iso_match = re.match(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})", line)
    if iso_match:
        try:
            return datetime.fromisoformat(iso_match.group(1))
        except ValueError:
            pass

    # Traditional syslog: Feb 14 21:05:08
    trad_match = re.match(r"(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})", line)
    if trad_match:
        try:
            month_str, day_str, time_str = trad_match.groups()
            year = datetime.now().year
            dt = datetime.strptime(f"{year} {month_str} {day_str} {time_str}", "%Y %b %d %H:%M:%S")
            return dt
        except ValueError:
            pass

    return None


def get_reboot_causes(boots):
    """For each boot timestamp, try to determine what caused the preceding shutdown.
    Returns a dict mapping boot_time -> {cause, detail, user?}
    """
    now = time.time()
    if _cause_cache["expires"] > now:
        return _cause_cache["data"]

    causes = {}
    if not boots:
        return causes

    # Parse boot timestamps
    boot_times = []
    for b in boots:
        try:
            # Strip timezone info for simpler comparison
            bt = datetime.fromisoformat(b.replace("Z", "+00:00"))
            # Make naive for comparison with log timestamps
            bt_naive = bt.replace(tzinfo=None)
            boot_times.append((b, bt_naive))
        except (ValueError, TypeError):
            continue

    if not boot_times:
        return causes

    # Read auth.log for sudo reboot/shutdown/halt/poweroff commands
    auth_lines = _read_auth_log()
    reboot_commands = []
    for line in auth_lines:
        if "COMMAND=" not in line:
            continue
        lower = line.lower()
        if not any(cmd in lower for cmd in ["reboot", "shutdown", "poweroff", "halt"]):
            continue
        ts = _parse_log_timestamp(line)
        if ts is None:
            continue
        # Extract user
        user_match = re.search(r"sudo:\s+(\w+)\s*:", line)
        user = user_match.group(1) if user_match else None
        # Extract command
        cmd_match = re.search(r"COMMAND=(.+)$", line)
        cmd = cmd_match.group(1).strip() if cmd_match else "reboot"
        reboot_commands.append({"ts": ts, "user": user, "cmd": cmd, "line": line})

    # Read syslog for power button events
    syslog_lines = _read_syslog()
    power_events = []
    for line in syslog_lines:
        if "Power key pressed" in line or "Powering off" in line:
            ts = _parse_log_timestamp(line)
            if ts:
                detail = "Power key pressed"
                if "short" in line.lower():
                    detail = "Power key pressed short"
                power_events.append({"ts": ts, "detail": detail})

    # For each boot, find the cause: look for events in the 5 minutes before boot
    for boot_str, boot_naive in boot_times:
        window_start = boot_naive - timedelta(minutes=5)

        # Check sudo reboot commands first (most specific)
        best_cmd = None
        best_delta = timedelta(minutes=6)  # beyond window
        for rc in reboot_commands:
            if window_start <= rc["ts"] <= boot_naive:
                delta = boot_naive - rc["ts"]
                if delta < best_delta:
                    best_delta = delta
                    best_cmd = rc

        if best_cmd:
            # Clean up the command path for display
            cmd_display = best_cmd["cmd"]
            # Strip /usr/sbin/ or /sbin/ prefix
            cmd_display = re.sub(r"^/usr/s?bin/|^/s?bin/", "", cmd_display)
            cause = {
                "cause": "user_command",
                "detail": cmd_display,
            }
            if best_cmd["user"]:
                cause["user"] = best_cmd["user"]
            causes[boot_str] = cause
            continue

        # Check power button events
        best_power = None
        best_delta = timedelta(minutes=6)
        for pe in power_events:
            if window_start <= pe["ts"] <= boot_naive:
                delta = boot_naive - pe["ts"]
                if delta < best_delta:
                    best_delta = delta
                    best_power = pe

        if best_power:
            causes[boot_str] = {
                "cause": "power_button",
                "detail": best_power["detail"],
            }
            continue

        # Unknown cause
        causes[boot_str] = {
            "cause": "unknown",
            "detail": "No reboot command found in logs",
        }

    _cause_cache["data"] = causes
    _cause_cache["expires"] = now + 120
    return causes


def collect_metrics():
    uptime_s = get_uptime()
    boot_time = datetime.fromtimestamp(
        time.time() - uptime_s, tz=timezone.utc
    ).isoformat()
    boots = get_recent_boots()
    return {
        "hostname": socket.gethostname(),
        "uptime_seconds": uptime_s,
        "boot_time": boot_time,
        "temperatures": get_temperatures(),
        "memory": get_memory(),
        "load_avg": get_load(),
        "cpu_percent": None,
        "gpu_percent": None,
        "recent_boots": boots,
        "reboot_causes": get_reboot_causes(boots),
        "disk": get_disk(),
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/metrics":
            data = json.dumps(collect_metrics())
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(data.encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # Silence request logs to avoid disk writes


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Fleet metrics agent listening on port {PORT}")
    server.serve_forever()
