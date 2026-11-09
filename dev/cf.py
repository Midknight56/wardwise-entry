r"""Runs wrangler against the hackathon Cloudflare account, without printing the token.

Usage: python dev/cf.py <wrangler args...>      e.g. python dev/cf.py deploy
       python dev/cf.py --ledger-id              prints the shared ledger's database id (an id, not a secret)

Reads `hackathon-cf-account.local.txt` from the secrets folder (MIDKNIGHT_SECRETS, else ~/.cloudflare) and passes the
account id and token to wrangler as environment variables only.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def secrets_dir():
    env = os.environ.get("MIDKNIGHT_SECRETS")
    return env if env and os.path.isdir(env) else os.path.join(os.path.expanduser("~"), ".cloudflare")


def read_kv():
    kv = {}
    with open(os.path.join(secrets_dir(), "hackathon-cf-account.local.txt"), encoding="utf-8") as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.rstrip("\n").split("=", 1)
                kv[k.strip()] = v.strip()
    return kv


def env_for_wrangler():
    kv = read_kv()
    env = dict(os.environ)
    env["CLOUDFLARE_ACCOUNT_ID"] = kv["CLOUDFLARE_ACCOUNT_ID"]
    env["CLOUDFLARE_API_TOKEN"] = kv["CLOUDFLARE_API_TOKEN"]
    return env


def main():
    args = sys.argv[1:]
    if args == ["--ledger-id"]:
        print(read_kv()["HACKATHON_LEDGER_D1_ID"])
        return 0
    r = subprocess.run(["npx", "wrangler", *args], cwd=ROOT, env=env_for_wrangler(), shell=(os.name == "nt"))
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
