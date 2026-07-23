"""Manual notification dispatch — NOT YET IMPLEMENTED.

Planned usage (per the spec):

    docker compose exec read python -m backend.notify <slug>

This script will:
  1. Resolve title + summary from the rendered post HTML (or CLI flags)
  2. Query active subscribers (unsubscribed_at IS NULL)
  3. Connect to smtp.gmail.com:587 with READ_SMTP_USER + READ_SMTP_APP_PASSWORD
  4. Send one plaintext message per subscriber with a per-recipient unsubscribe link
  5. Log sent/failed counts

See docs/superpowers/specs/2026-05-13-read-email-subscriptions-design.md.
"""
import sys


def main() -> int:
    print(
        "backend.notify is not yet implemented.\n"
        "See docs/superpowers/specs/2026-05-13-read-email-subscriptions-design.md "
        "for the planned notification flow.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
