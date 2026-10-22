# 0voice AV Study Tracker

A deployable study tracker for the 0voice audio-video learning plan.

## Features

- Responsive workspace with Today, Weekly Plan, and Milestones views
- One-click check-ins with Undo and precise video segment times
- Separate course and career navigation: 33 course weeks, three reference calendar weeks for weekday project materials and Saturday skill inventories, then teacher confirmation and relative interview sessions
- Weekly topics for 0voice and Edoyun/project work, plus source and completion filters
- Direct next-lesson details, month-grouped week selection, and mobile bottom navigation
- Back/Forward location history with Alt+Left/Right, restoring tasks, views, filters and scroll positions
- Continue from actual progress, including missed sessions and optional early study, while keeping calendar dates intact
- Resume video segments from a saved timestamp and project work from saved steps and elapsed minutes
- Keep early weekday project practice to a resumable 40-minute session without changing the original task workload
- Project completion follows required courses, practice and final self-test; requirements, application preparation and historical evidence expand on demand and retain their reading state during navigation
- Local cache for offline use
- Server-side sync for multi-device progress sharing
- Optional sync key protection
- Complete backup export and previewed restore, with Undo for restore and reset
- Queued sync that preserves check-ins made during an earlier request, validates acknowledgements, and retries temporary failures
- Refresh progress while the page is visible, resolve open-draft conflicts, and preserve full restores across browser tabs

The frontend lives in `study-tracker.html` (schedule data), `tracker-ui.css` (layout), and `tracker-ui.js` (interaction and sync). Keep these three files together when copying or deploying the project. Open **数据与同步** to manage the sync key and backup files. Previous schedule records remain archived. Compatible video intervals retain their recorded progress. Rewritten practice and career modules link to historical notes, evidence and timestamps without inheriting completion for a different scope.

## Current study plan

The plan targets **C++ streaming media servers**. There are **208 independent records: 207 required and one on-demand remediation pool**, across **33 course/practice weeks and three material-preparation reference weeks**. Actual progress controls recommendations; reference dates never mark unfinished work complete.

**0voice now contains 117 original videos, 81:15:33 in total, split into 122 weekday sessions.** The first 121 sessions are exactly 40 minutes; the final session contains the remaining 35:33. Long videos span days and short videos share a session, with exact source timestamps. The reference calendar remains October 5, 2026 onward and finishes **March 23, 2027**. Existing covered intervals remain covered; the new schedule does not restart completed videos.

The 12-module sequence is media API → encoding/FLV → MP4/hardware processing/filters → RTMP → HLS protocol → SRS core/HTTP-FLV → SRS distribution/clusters/HLS → RTSP/RTP/RTCP → ZLMediaKit → WebRTC foundations → SRS RTC/transport → WHIP/WHEP. Selected lessons retain their original order inside each course; SRS HLS 154→155→156 corrects a catalog ordering error. RTMP finishes December 4 and SRS core starts December 11. Weekly themes follow actual source topics. Course selection, daily time, completion date and Edoyun schedules are unchanged.

Added required videos are RTSP/RTP/SDP/RTCP lessons 158–166 and 2026 WHIP/WHEP lessons 1–4. Only the selected required 0voice courses are listed; additional courses can be chosen later as needed. Historical learning records remain available in backups. Previously mastered C++/Linux, FFmpeg memory and elementary bitstream/container topics are not added. Explicit duplicate versions retain only the newer course: FFmpeg 6.0 FLV remains required; 4.2 stays historical only.

All **165 Edoyun lessons and 84:18:49 of video** remain scheduled once, with their IDs and exact intervals unchanged. Projects run strictly in series: **Yibo → Cloud Teaching → Course Studio**. Each project's required video, practice and self-test must finish before the next. The 35 complete practice modules retain their content and a **103.5-hour initial estimate**.

| Project | Video dates and weekly ceiling | Practice modules / estimate | Project self-test target |
| --- | --- | --- | --- |
| Yibo Linux server | 2026-10-10–2026-11-14, at most 5 hours | 10 / 24 hours | 2026-11-28 |
| Cloud Teaching | 2026-12-05–2027-01-30, at most 4 hours | 11 / 33.5 hours | 2027-02-06 |
| Course Studio | 2027-02-20–2027-05-08, at most 2 hours | 14 / 46 hours | 2027-05-20 |

Weekdays remain 0voice until it is actually complete, then provide up to 40 minutes for the current project's eligible practice. The reference transition is **March 24**. Days awaiting prerequisite videos stay flexible. Saturday video and practice are separate; practice is capped at 3.5 hours in weeks 1–17 and five hours thereafter. After 0voice, the reference schedule uses up to three Saturday practice hours and continues eligible modules on weekdays. Sundays remain free. The busiest fixed week is **11 hours 50 minutes**. Required learning initially ends May 20, before the May 31 course deadline and June 7 platform expiry. No independent portfolio or extra feature phase is required.

A complete practice module has one task ID, progress record and set of outputs. `workSessions` distributes its workload across dates, without duplicating task counts. Scope still includes Yibo HTTP/database/crypto integration, Cloud load distribution and dual audio/video paths, and Studio YuNet/effects, scene JSON, Transform/Z-order and AI Hooks. Each project has one final self-test with running instructions. Milestones use the same required-task completion as project recommendations: finishing all required work completes the project, and cancelling a check-in reopens it. There is no separate acceptance action. Completion requirements and saved historical evidence are collapsed by default; raw evidence, timestamps, backup and sync remain unchanged. Recording-index/replay, standalone RTC and broader quality/scale projects remain optional directions.

**The Edoyun teacher customizes the resume.** After all learning, four project-preparation modules use 14 weekday sessions of about 40 minutes: completed Remote Control four, Yibo two, Cloud Teaching five and Studio three. Their reference dates are **May 24–June 10**. The user's alternatives of 1, 0.5, 2 and 1.5 rest days replace weekday sessions rather than adding work. Skill inventories occupy May 29 (audio/video, two hours) and June 5 (tooling and C++17, one hour each). The seven modules organize existing work and do not require extra development or a self-written resume.

After all seven material modules, an undated **teacher confirmation event** records discussion notes, the teacher's resume version/link and factual review. Only after actual confirmation do **15 relative interview-preparation sessions, 40 minutes each**, become the default direction. Teacher waiting time and interviews have no fixed calendar completion date. Manually recorded later work cannot bypass unfinished learning, materials or confirmation; reversing confirmation restores its prerequisite without deleting records.

The career page uses the same daily task cards and circular check-ins as the course plan. Search includes required original course titles; outlines and completion counts link to relevant records. Back/Forward and **Alt+Left/Right** preserve views, week/filter selections and scroll positions. Manual early study remains available alongside dependency-aware default recommendations.

The 154 early 0voice sessions, 122 prior 40-minute sessions and 205 former split lesson entries remain unchanged as historical metadata. Together with earlier archives there are now **322 legacy video tasks, 207 legacy lesson entries, 212 historical reference tasks and 39 legacy practice tasks**. `legacyZeroVoiceVideoRanges` maps each old segment to the exact original source interval, so playback stops and compatible completion carry forward without changing notes, evidence or timestamps. The 122 canonical source sessions also migrate by exact source seconds; `legacyZeroVoiceVideoGenerations` ensures newer cancellations or corrected stops override only their own intervals. Uncovered source tails remain pending; different course versions never inherit completion. Version 3 backups, previewed restore/Undo and cross-device sync preserve both current and archived records. The backend schema is unchanged.

The raw Edoyun catalogue remains outside the repository in `/root/eDaoYun/`. `week.totalMin` contains fixed required 0voice video minutes; `week.scheduledMinutes` sums actual fixed video/session allocations. See [study-plan.md](study-plan.md) for module dates and the weekly reference calendar.

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

For syntax and browser regression checks:

```bash
npm run check
npx playwright install --with-deps chromium
npm test
```

Schedule checks verify phase boundaries, topic-to-lesson references, video coverage, time budgets, dependencies, and milestone membership. Additional isolated checks cover backup validation, project evidence, sync retries, and SQLite migration. Browser checks use a temporary database and a separate server. Set `BROWSER_EXECUTABLE_PATH` if you want to use an existing Chromium installation.

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
bash scripts/deploy-nginx.sh
```

By default, this project is exposed at:

```text
/0voice-av-study-tracker/
```

So after deployment you can visit:

```text
http://your-server-ip/0voice-av-study-tracker/
```

This script still supports two nginx exposure modes:

- `EXPOSE_MODE=subdomain`: one host name per service
- `EXPOSE_MODE=path`: one host name with multiple path prefixes

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
bash scripts/deploy-nginx.sh
```

By default the nginx `server_name` is `_`, which works for direct IP access, and the path prefix is fixed to:

```text
/0voice-av-study-tracker/
```

If you already have a domain, pass it in when you run the script:

```bash
DOMAIN=tracker.example.com bash scripts/deploy-nginx.sh
```

If you really want to override the default path, you still can:

```bash
EXPOSE_MODE=path PATH_PREFIX=/tracker bash scripts/deploy-nginx.sh
```

Or use a shared domain plus a custom path:

```bash
DOMAIN=tools.example.com EXPOSE_MODE=path PATH_PREFIX=/tracker bash scripts/deploy-nginx.sh
```

The full deploy script will:

- run `scripts/deploy.sh`
- install nginx if needed
- write an nginx reverse-proxy config
- enable the site and reload nginx

After that, make sure your Alibaba Cloud security group allows `TCP/80`.

### Recommended layouts for multiple services

Different subdomains:

```bash
DOMAIN=tracker.example.com EXPOSE_MODE=subdomain bash scripts/deploy-nginx.sh
DOMAIN=lab.example.com EXPOSE_MODE=subdomain bash scripts/deploy-nginx.sh
```

Different paths on one host:

```bash
DOMAIN=tools.example.com EXPOSE_MODE=path PATH_PREFIX=/tracker bash scripts/deploy-nginx.sh
DOMAIN=tools.example.com EXPOSE_MODE=path PATH_PREFIX=/demo bash scripts/deploy-nginx.sh
```
