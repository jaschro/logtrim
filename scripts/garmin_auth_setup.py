#!/usr/bin/env python3
"""
Run this ONCE on your local machine to generate Garmin auth tokens for GitHub Actions.

Usage:
  pip install garminconnect
  python scripts/garmin_auth_setup.py

Then copy the printed string and add it as a GitHub secret:
  GitHub repo → Settings → Secrets and variables → Actions → New repository secret
  Name:  GARMIN_TOKENS
  Value: (the long string printed below)

You'll only need to re-run this if the tokens expire (typically after 30+ days of
the workflow not running, or if Garmin invalidates your session).
"""
import base64
import getpass
import io
import os
import sys
import tarfile

try:
    from garminconnect import Garmin
except ImportError:
    os.system(f"{sys.executable} -m pip install garminconnect")
    from garminconnect import Garmin

email    = input("Garmin email: ").strip()
password = getpass.getpass("Garmin password: ")

def prompt_mfa():
    return input("Garmin MFA/OTP code (check your email): ").strip()

print("\nLogging in to Garmin Connect…")
g = Garmin(email=email, password=password, prompt_mfa=prompt_mfa)
g.login()

token_dir = os.path.expanduser("~/.garth")
os.makedirs(token_dir, exist_ok=True)

# garminconnect API varies by version — try each possible path
saved = False
for getter in [
    lambda: g.garth,
    lambda: g.client.garth,
    lambda: g.client,
]:
    try:
        obj = getter()
        if hasattr(obj, 'dump'):
            obj.dump(token_dir)
            saved = True
            break
    except AttributeError:
        continue

if not saved:
    # garth may have auto-saved tokens to ~/.garth during login
    files = os.listdir(token_dir) if os.path.exists(token_dir) else []
    if files:
        print(f"Using {len(files)} token file(s) auto-saved to {token_dir}")
        saved = True
    else:
        print("ERROR: Login succeeded but couldn't save tokens.")
        print("Garmin attrs:", [a for a in dir(g) if not a.startswith('_')])
        sys.exit(1)
else:
    print(f"Tokens saved to {token_dir}")

# Bundle into a gzipped tarball and base64-encode it
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w:gz') as tar:
    tar.add(token_dir, arcname='.garth')
buf.seek(0)
encoded = base64.b64encode(buf.read()).decode('ascii')

print()
print("=" * 60)
print("Add this as a GitHub Actions secret:")
print("  Name:  GARMIN_TOKENS")
print("  Value: (the string on the next line)")
print("=" * 60)
print(encoded)
print("=" * 60)
print()
print("GitHub: repo → Settings → Secrets and variables → Actions → New repository secret")
