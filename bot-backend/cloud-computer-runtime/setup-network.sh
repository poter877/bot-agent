#!/usr/bin/env bash
# Run on the dedicated Linux Docker worker host, never in the API/application container.
set -euo pipefail

NETWORK="${1:-bot-cloud-desktop}"
SUBNET="${2:-172.30.0.0/24}"
BRIDGE=br-bot-cloud
[[ "$EUID" -eq 0 ]] || { echo "Run this script as root on the dedicated Linux worker host." >&2; exit 1; }
[[ "$NETWORK" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Invalid network name" >&2; exit 1; }
python3 - "$SUBNET" <<'PY'
import ipaddress
import sys
network = ipaddress.ip_network(sys.argv[1], strict=True)
if network.version != 4 or not network.is_private or network.prefixlen < 16:
    raise SystemExit("Choose a private IPv4 subnet with prefix /16 or smaller address space")
PY

command -v docker >/dev/null
command -v iptables >/dev/null
# The worker verifies this same helper before every start and desktop operation.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/firewall-policy.py" install

if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  docker network inspect "$NETWORK" | python3 -c '
import json,sys
n=json.load(sys.stdin)[0]
expected={"com.docker.network.bridge.enable_icc":"false","com.docker.network.bridge.name":"br-bot-cloud"}
if (n.get("Driver") != "bridge" or n.get("EnableIPv6") is not False
    or n.get("Labels",{}).get("bot.cloud.network-policy") != "restricted-v1"
    or any(n.get("Options",{}).get(k) != v for k,v in expected.items())
    or n.get("IPAM",{}).get("Config",[{}])[0].get("Subnet") != sys.argv[1]):
    raise SystemExit("Existing network differs from the restricted policy; migrate it explicitly before use.")
' "$SUBNET"
else
  docker network create --driver bridge --subnet "$SUBNET" \
    --opt com.docker.network.bridge.enable_icc=false \
    --opt com.docker.network.bridge.name="$BRIDGE" \
    --label bot.cloud.network-policy=restricted-v1 "$NETWORK"
fi
echo "Restricted network ready. Persist these firewall rules and restore them before starting the worker after reboot."
