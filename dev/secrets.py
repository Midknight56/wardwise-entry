"""Prepare sandbox secrets without printing values. Usage: secrets.py dev-vars | put."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def values():
    source = Path('C:/Users/User/.cloudflare/paypal-sandbox.local.txt')
    parsed = {}
    for line in source.read_text(encoding='utf-8-sig').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            parsed[key.strip()] = value.strip().strip('"').strip("'")
    webhook = (ROOT / '.wrangler/webhook-id.txt').read_text(encoding='utf-8-sig').strip()
    result = {'PAYPAL_CLIENT_ID': parsed['PAYPAL_SANDBOX_CLIENT_ID'],
              'PAYPAL_CLIENT_SECRET': parsed['PAYPAL_SANDBOX_SECRET'],
              'PAYPAL_WEBHOOK_ID': webhook,
              'PAYOUT_EMAIL_CREW': parsed['PAYPAL_SANDBOX_BUYER_EMAIL']}
    if not all(result.values()):
        raise ValueError('A required secret is empty.')
    return result


def main():
    if sys.argv[1:] not in [['dev-vars'], ['put']]:
        raise ValueError('Usage: python dev/secrets.py dev-vars | put')
    config = values()
    if sys.argv[1] == 'dev-vars':
        config.update(DEV_ROUTES='1', LIVE_AI='1')
        # A fresh file with user-only permissions on POSIX; Windows inherits workspace ACLs.
        path = ROOT / '.dev.vars'
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write('\n'.join(f'{key}={json.dumps(value)}' for key, value in config.items()) + '\n')
    else:
        for name, value in config.items():
            # Capture subprocess output so no provider error can echo a secret value.
            result = subprocess.run([sys.executable, str(ROOT / 'dev/cf.py'), 'secret', 'put', name],
                                    input=value + '\n', text=True, capture_output=True, cwd=ROOT)
            if result.returncode:
                raise RuntimeError(f'Secret put failed for {name}, exit {result.returncode}.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Avoid exception text from parsers or tools that might include secret contents.
        print(f'Secret setup failed ({type(error).__name__}). Check the source file and webhook id.', file=sys.stderr)
        sys.exit(1)
