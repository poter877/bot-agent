"""Run on the Linux worker host: exercise a disposable real desktop, then remove only its resources."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import uuid


def docker(binary: str, *args: str) -> str:
    return subprocess.run([binary, *args], capture_output=True, text=True, check=True, timeout=30).stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:3031")
    parser.add_argument("--output", default="cloud-smoke.png", type=Path)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    token = os.environ["CLOUD_WORKER_TOKEN"]
    executable = os.environ.get("CLOUD_WORKER_DOCKER", "docker")
    computer = str(uuid.uuid4())
    owner = f"smoke-{uuid.uuid4()}"
    digest = hashlib.sha256(owner.encode()).hexdigest()
    container = "bot-cloud-" + hashlib.sha256(computer.encode()).hexdigest()[:32]
    volume = "bot-cloud-home-" + digest[:32]

    def request(suffix: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{args.base.rstrip('/')}/v1/computers/{computer}{suffix}", data=data,
                                     method="POST" if suffix else "GET",
                                     headers={"Authorization": f"Bearer {token}", "X-Cloud-Owner": owner,
                                              "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=35) as response:
            return json.load(response)

    try:
        assert request("/start")["state"] == "running"
        image = request("/capture")["image"]
        pixels = base64.b64decode(image["data"], validate=True)
        assert image["mediaType"] == "image/png" and pixels.startswith(b"\x89PNG\r\n\x1a\n")
        args.output.write_bytes(pixels)
        request("/actions", {"action": "click", "params": {"x": image["width"] // 2, "y": image["height"] // 2}})
        request("/actions", {"action": "key", "params": {"keys": ["Escape"]}})
        marker = str(uuid.uuid4())
        docker(executable, "exec", "--user", "1000:1000", container, "python3", "-c",
               "from pathlib import Path; import sys; Path('/home/desktop/.smoke-persistence').write_text(sys.argv[1])", marker)
        assert request("/stop")["state"] == "stopped"
        assert request("/start")["state"] == "running"
        assert docker(executable, "exec", "--user", "1000:1000", container, "cat", "/home/desktop/.smoke-persistence") == marker
        assert request("/capture")["image"]["width"] == image["width"]
        print(f"Cloud desktop smoke test passed; screenshot: {args.output.resolve()}")
    finally:
        if not args.keep:
            # Names derive solely from this test's random IDs. Confirm the owner label before cleanup.
            raw = docker(executable, "ps", "-a", "--filter", f"name=^{container}$", "--format", "{{.Names}}")
            if raw == container:
                owned = json.loads(docker(executable, "inspect", container))[0]["Config"]["Labels"]
                if owned.get("bot.cloud.owner") == digest:
                    request("/stop")
                    docker(executable, "rm", container)
                    docker(executable, "volume", "rm", volume)


if __name__ == "__main__":
    main()
