# Backups

Two kinds of copy. Use both.

## 1. Quick copy inside Tally (every week, or before a big import)

Settings, General, Backup, Download a backup. You get one JSON file with every record your workspace holds, including deleted ones. It is for safekeeping and moving data out. It is not a one click restore.

## 2. Full database copy (the real safety net)

Needs the free Postgres tools on your Mac: `brew install postgresql@16` (the tool version must be 16 or newer).

Get the database address from Neon (Connect button, role `neondb_owner`). Put it in your terminal without pasting it anywhere else:

    read -s NEON_URL      # paste the address, press Enter (nothing shows on screen)
    pg_dump "$NEON_URL" --format=custom --no-owner --file=tally-$(date +%F).dump

Check the file is not empty: `ls -lh tally-*.dump`. Keep it somewhere safe, like a cloud drive.

## Getting a copy back

Make a new empty Neon project (or a local database), then:

    read -s NEW_URL
    pg_restore --no-owner --dbname="$NEW_URL" tally-YYYY-MM-DD.dump

Point Render's DATABASE_URL and MIGRATE_DATABASE_URL at the new database and redeploy. The two roles (crm_api, neondb_owner) must exist there; the app's startup migrations check the rest.

## Oops moments

Neon's free plan can rewind the database up to 6 hours (Neon, Branches, Restore). After that, only your copies help.

## Habit

Weekly full copy, plus a quick copy before any big import. Never paste the database address into chat or commit it.
