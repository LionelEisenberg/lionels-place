# Disaster Recovery — rebuild the stack from scratch

This repo restores the **stack** — every container, its configuration, and how they wire
together. It does not restore **data**. Libraries, databases, and credentials all come
from your own backups, taken before whatever incident sent you here.

## 0. What you need

Gather these before you start:

- **Backups**: `vaultwarden/data/` (the full directory), Helm's `fitness.db`, Jellyfin's
  config databases, an Immich Postgres dump plus the photo library itself, your media
  drives, and Read's `subscribers.db`.
- **A password manager** with every value the four `.env` files below need (API tokens,
  a JWT secret, OAuth client IDs, etc.) — none of it ships in this repo, by design.
- A mental note that the `*arr` stack (Radarr/Sonarr/Prowlarr/Jellyseerr) has **no
  config backup to restore** — none of it was ever tracked in git. Rebuilding the stack
  gives you working containers, not your old indexers, root folders, or API keys; those
  get set up again by hand after first start.

**Taking the Vaultwarden backup** (do this now, regularly, while the service is
healthy — not only when disaster is already underway):

```bash
docker exec vaultwarden sqlite3 /data/db.sqlite3 ".backup '/data/backup.sqlite3'"
```

Copy `backup.sqlite3`, the `rsa_key*` files, and the `attachments/` directory out of
`vaultwarden/data/` to your backup location. This is your password manager — treat this
backup as seriously as the vault itself.

## 1. Base machine

- Docker Desktop (Windows) or Docker Engine + Compose v2 (Linux) on the new host.
- `git clone` this repo onto it.

## 2. Secrets

Four `.env.example` files become `.env` files, filled with real values:

```bash
cp .env.example .env
cp helm/.env.example helm/.env
cp read/.env.example read/.env
cp immich/.env.example immich/.env
```

Fill in every variable — each file's own comments say where the value comes from
(`openssl rand -hex 32`, a provider dashboard, etc.). Never commit the filled-in files.

## 3. Host paths

`docker-compose.yml` hardcodes the previous machine's paths — Windows drive letters and a
specific username:

- `L:\Movies`, `L:\TV Shows`, `L:\Music`, `L:\Photos`
- `C:\Users\<user>\Downloads`
- `C:\Users\<user>\.claude` (Claude Max auth, mounted into `llm-worker`)

Edit every `volumes:` entry referencing one of these to match the new host before
starting anything.

## 4. Restore data BEFORE first start

**Never boot the stack against an empty data directory "just to see it come up."**
Helm and Read both run schema setup against whatever they find in their data directory on
first boot — an empty directory there becomes a freshly-initialized empty database
sitting exactly where your restored one needs to go, and now you have two to untangle.
Restore first, always.

- `vaultwarden/data/` — copy the entire backed-up directory into place. To restore just
  the database from the backup above (service stopped):
  ```bash
  docker compose stop vaultwarden
  cp /path/to/backup/backup.sqlite3 vaultwarden/data/db.sqlite3
  cp /path/to/backup/rsa_key* vaultwarden/data/
  cp -r /path/to/backup/attachments vaultwarden/data/
  docker compose up -d vaultwarden
  ```
- `helm/data/fitness.db` — copy into place before first start.
- `read/data/subscribers.db` — copy into place before first start.
- Jellyfin — copy your backed-up config databases into `jellyfin/config/`.
- Immich — bring up the database alone, restore into it, then start the rest:
  ```bash
  docker compose --profile immich up -d immich-database
  # wait for it to report healthy, then:
  cat immich_backup.sql | docker exec -i immich-database psql --username=immich --dbname=immich
  docker compose --profile immich up -d
  ```

## 5. Start + verify

```bash
docker compose up -d                      # core stack
docker compose --profile immich up -d     # + photos, once its data is restored
```

- Jellyfin plugin **DLLs are not shipped** in this repo (binary artifacts, not source) —
  reinstall whatever plugins you had from the in-app catalog.
- Cloudflare DNS repoints itself automatically once `cloudflare-ddns` starts and detects
  the new home IP — no manual DNS edit needed.
- Work through the [routing table](./README.md#routing) hostname by hostname and confirm
  each resolves to the right service.

## 6. Post-restore checks

- **Helm**: log in with your Jellyfin credentials. Confirm the hourly Google Health sync
  is actually firing — it's gated on `HEALTH_SYNC_SECRET` matching between `helm` and
  `helm-health-sync`, and a mismatch there looks like silence, not an error.
- **Vaultwarden**: open the vault and confirm every entry is present and unlockable
  *before* deleting any old copy of `vaultwarden/data/`. There is no second chance if the
  restore was subtly wrong.
