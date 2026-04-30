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
```

- `PORT`: server port
- `TRACKER_API_KEY`: optional sync key for the API

## Deploy

1. Install Node.js 18+
2. Upload this project folder to your server
3. Create `.env`
4. Run `npm install`
5. Run `npm start`

The sync data file is stored at `data/tracker-state.json`.
