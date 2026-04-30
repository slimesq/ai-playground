# 0voice AV Study Tracker

A deployable study tracker for the 0voice audio-video learning plan.

## Features

- Weekly learning schedule and daily check-in view
- Local cache for offline use
- Server-side sync for multi-device progress sharing
- Optional sync key protection
- Import and export backup data

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open:

```text
http://localhost:3000
```

## Environment

```env
PORT=3000
TRACKER_API_KEY=
DB_PATH=./data/tracker.db
BACKUP_DIR=./data/backups
BACKUP_INTERVAL_MINUTES=360
BACKUP_RETENTION=14
```

- `PORT`: server port
- `TRACKER_API_KEY`: optional sync key for the API
- `DB_PATH`: SQLite file path; keep this file when you redeploy
- `BACKUP_DIR`: directory for local SQLite snapshot backups
- `BACKUP_INTERVAL_MINUTES`: how often the app writes a local backup
- `BACKUP_RETENTION`: how many backup files to keep

## Deploy

1. Install Node.js 22+
2. Upload this project folder to your server
3. Run the deploy script:

```bash
bash scripts/deploy.sh
```

If you want the app and nginx to be configured in one shot, use:

```bash
bash scripts/deploy-full.sh
```

You can override defaults when you run it:

```bash
TRACKER_API_KEY=your-secret \
PORT=3000 \
DATA_ROOT=/var/lib/0voice-av-study-tracker \
bash scripts/deploy.sh
```

If you want to remove an existing sync key:

```bash
CLEAR_TRACKER_API_KEY=1 bash scripts/deploy.sh
```

The script will:

- write `.env`
- install dependencies
- create persistent data and backup directories
- install `pm2` if needed
- start or restart the service with `pm2`

Without the deploy script, the app defaults to `data/tracker.db`.
When you deploy with `scripts/deploy.sh`, it writes the database to `${DATA_ROOT}/tracker.db` and backups to `${DATA_ROOT}/backups` by default.
If an old `data/tracker-state.json` file exists, the server will import it automatically on first start.
The app also creates rolling SQLite backups in `BACKUP_DIR`, keeps the newest snapshots, and writes a startup snapshot when data already exists.

An nginx example config is included at `deploy/nginx.conf.example`.

## One-shot deploy with nginx

If you want the server to be reachable directly on port 80, run:

```bash
bash scripts/deploy-full.sh
```

By default the nginx `server_name` is `_`, which works for direct IP access.

If you already have a domain, pass it in when you run the script:

```bash
DOMAIN=tracker.example.com bash scripts/deploy-full.sh
```

The full deploy script will:

- run `scripts/deploy.sh`
- install nginx if needed
- write an nginx reverse-proxy config
- enable the site and reload nginx

After that, make sure your Alibaba Cloud security group allows `TCP/80`.
