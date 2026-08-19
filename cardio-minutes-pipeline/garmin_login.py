#!/usr/bin/env python3
"""
garmin_login.py — run ONCE, locally, to generate the Garmin token blob.

    pip install garminconnect
    python scripts/garmin_login.py

It will prompt for your Garmin email/password (and MFA code if enabled),
then print a base64 token blob. Put that blob in the GitHub repo secret
GARMIN_TOKENS. Tokens stay valid for about a year; when the Action starts
failing with auth errors, just run this again and update the secret.

Your password is used only for this login and is never stored.
"""

import getpass

from garminconnect import Garmin


def main() -> None:
    email = input("Garmin email: ").strip()
    password = getpass.getpass("Garmin password: ")
    g = Garmin(email=email, password=password, return_on_mfa=True)
    result1, result2 = g.login()
    if result1 == "needs_mfa":
        code = input("MFA code (check your email if you don't use an authenticator): ").strip()
        g.resume_login(result2, code)

    # garminconnect >= 0.3.10 exposes tokens on g.client; older versions on g.garth
    if hasattr(g, "client") and hasattr(g.client, "dumps"):
        blob = g.client.dumps()
    else:
        blob = g.garth.dumps()

    # Belt and suspenders: also save to a local file so a copy/paste mishap
    # or console crash can't lose the hard-won tokens.
    with open("garmin_tokens.json", "w") as f:
        f.write(blob)

    print("\n--- GARMIN_TOKENS (copy everything below into the secret) ---\n")
    print(blob)
    print("\n(Also saved to garmin_tokens.json in the current directory.")
    print(" Delete that file after you've added the GitHub secret.)")


if __name__ == "__main__":
    main()
