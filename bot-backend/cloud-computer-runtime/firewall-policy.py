"""Install and verify the same ordered egress policy on the dedicated Docker host."""
from __future__ import annotations

import argparse
import subprocess
import sys

BRIDGE = "br-bot-cloud"
CHAIN = "BOT_CLOUD_EGRESS"
DENIED = ("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
          "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4")
EGRESS_RULES = [*[ ["-d", cidr, "-j", "REJECT"] for cidr in DENIED ],
                ["-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN"],
                ["-p", "tcp", "-m", "multiport", "--dports", "80,443", "-j", "RETURN"],
                ["-p", "udp", "--dport", "53", "-j", "RETURN"],
                ["-p", "tcp", "--dport", "53", "-j", "RETURN"], ["-j", "REJECT"]]
JUMPS = {"DOCKER-USER": ["-i", BRIDGE, "-j", CHAIN], "INPUT": ["-i", BRIDGE, "-j", "REJECT"]}


def run(binary: str, args: list[str], *, check=True):
    return subprocess.run([binary, "-w", *args], capture_output=True, text=True, check=check, timeout=5)


def normalized(line: str) -> str:
    # iptables -S prints implicit protocol modules/reject defaults and sorts conntrack states.
    return (line.replace(" -m tcp", "").replace(" -m udp", "")
            .replace(" --reject-with icmp-port-unreachable", "")
            .replace("RELATED,ESTABLISHED", "ESTABLISHED,RELATED"))


def rules(binary: str, chain: str) -> list[str]:
    return [normalized(line) for line in run(binary, ["-S", chain]).stdout.splitlines() if line.startswith("-A ")]


def verify(binary: str) -> None:
    for chain, rule in JUMPS.items():
        actual = rules(binary, chain)
        if not actual or actual[0] != " ".join(["-A", chain, *rule]):
            raise ValueError(f"{chain} must begin with the cloud desktop firewall rule")
    expected = [" ".join(["-A", CHAIN, *rule]) for rule in EGRESS_RULES]
    if rules(binary, CHAIN) != expected:
        raise ValueError("Cloud desktop egress rules are missing, reordered or permissive")


def install(binary: str) -> None:
    run(binary, ["-S", "DOCKER-USER"])
    if run(binary, ["-S", CHAIN], check=False).returncode:
        run(binary, ["-N", CHAIN])
    existing = rules(binary, CHAIN)
    expected = [" ".join(["-A", CHAIN, *rule]) for rule in EGRESS_RULES]
    # Never flush a live chain. A changed policy requires explicit maintenance with desktops stopped.
    if existing and existing != expected:
        raise ValueError("Existing cloud egress policy differs; stop desktops and migrate it explicitly")
    if not existing:
        for rule in EGRESS_RULES:
            run(binary, ["-A", CHAIN, *rule])
    for chain, rule in JUMPS.items():
        current = rules(binary, chain)
        if not current or current[0] != " ".join(["-A", chain, *rule]):
            run(binary, ["-I", chain, "1", *rule])
    verify(binary)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["install", "verify"])
    parser.add_argument("--iptables", default="iptables")
    args = parser.parse_args()
    {"install": install, "verify": verify}[args.action](args.iptables)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Cloud network policy check failed: {error}", file=sys.stderr)
        sys.exit(1)
