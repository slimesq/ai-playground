# 0voice AV Study Tracker

A deployable study tracker for the 0voice audio-video learning plan.

## Features

- Responsive workspace with Today, Weekly Plan, and Milestones views
- One-click check-ins with Undo and precise video segment times
- Separate 34-week course and 18-week project navigation, with search across both phases
- Weekly topics for 0voice and Edoyun/project work, plus source and completion filters
- Direct next-lesson details, month-grouped week selection, and mobile bottom navigation
- Back/Forward location history with Alt+Left/Right, restoring tasks, views, filters and scroll positions
- Continue from actual progress, including missed sessions and optional early study, while keeping calendar dates intact
- Resume video segments from a saved timestamp and project work from saved steps and elapsed minutes
- Keep early weekday project practice to a resumable 40-minute session without changing the original task workload
- Separate course/project progress and independent project acceptance with evidence notes
- Local cache for offline use
- Server-side sync for multi-device progress sharing
- Optional sync key protection
- Complete backup export and previewed restore, with Undo for restore and reset
- Queued sync that preserves check-ins made during an earlier request, validates acknowledgements, and retries temporary failures
- Refresh progress while the page is visible, resolve open-draft conflicts, and preserve full restores across browser tabs

The frontend lives in `study-tracker.html` (schedule data), `tracker-ui.css` (layout), and `tracker-ui.js` (interaction and sync). Keep these three files together when copying or deploying the project. Open **数据与同步** to manage the sync key and backup files. Previous schedule records remain archived and do not count toward the revised plan.

## Current study plan

**All coursework finishes by May 2027.** The original 207 0voice lessons (156 sessions, 6271 minutes) end on **2027-05-10**. The 165 Yidaoyun lessons (84:18:49 total) end on **2027-05-22**, followed by a final catch-up and engineering check on **May 29**, before the **May 31 course deadline**. No June course rewatch tasks remain.

Before 0voice completion, weekdays contain one 35–45 minute 0voice session. Starting **May 11**, Monday and Tuesday become 40-minute interview preparation; Wednesday through Friday become 40-minute project sessions. The transition week keeps the last 0voice lesson on Monday May 10 and starts interviews on Tuesday. Saturdays retain five hours, split into viewing/practice or implementation/verification. Sundays remain free. Typical time is 8 hours 20 minutes per week, with a maximum of 8 hours 33 minutes.

The Weekly Plan defaults to the **34-week course phase (October 5–May 30)**, with separate 0voice and Edoyun topics based on the lessons actually assigned each week. The later **18-week project phase (May 31–October 3)** is available through its own switch and starts again at week 1. Search covers both phases; current-week and milestone jumps select the matching phase automatically.

The later schedule is **independent project work and interview preparation**, separate from course completion. These 18 weeks reserve **126 project hours**: two weekday hours plus five Saturday hours per week, including 21 hours of final integration buffer. Project week 11 checks the MVP. Interview preparation starts in May; applications tentatively start October 4. The **364 tasks** belong to six project milestones and two parallel goals, preserving original 0voice IDs, dates and segments. The completed remote-control project remains separate.

The **Continue learning** panel follows actual completion within each source, so it can suggest the earliest missed session or the next future session. It preserves gaps when later tasks are checked off early. Weekends default to Edoyun/projects; weekdays default to 0voice until it is actually complete, then Monday/Tuesday to interviews and Wednesday–Friday to projects. Manual source switching remains available. Calendar navigation and assigned dates stay unchanged.

Early weekday project practice offers a session of up to 40 minutes, keeping the original task duration visible. Save the session's minutes and finished steps in task details, then resume the same task next time. Video details save the selected segment and the exact position within its original video. Partial progress is independent of completion: it syncs, exports in version 3 backups, and survives Undo without increasing completed-task counts. Completed video and project tasks show saved progress first; choose **编辑进度** to update those records while preserving completion.

The **返回／前进** arrows and **Alt+Left/Right** revisit locations within the current tab, including the selected week, search filters and task-detail scroll position. New navigation after returning starts a new branch. Unsaved task and acceptance drafts require confirmation before leaving. Search results show matching lesson names and open the corresponding video segment directly. Quick practice recording asks for actual minutes; task details also allow correcting the previously accumulated total. Completed-task edits can be cancelled, and Save is available only after a change.

Progress category and project names jump to their next unfinished task. Their completed counts open all corresponding check-ins within the selected phase; total counts open every scoped task. **查看记录** in a completed Continue direction includes its check-ins across both phases, with saved result links and controls to correct mistaken check-ins. These entries use the same outline, grouped by week with the relevant course topic. One relevant week starts expanded; select a week, jump to work in progress or the next incomplete task, or expand all weeks. Completion filters include **进行中** and retain the outline layout. Each scope and completion filter remembers its located week, expanded tasks and scroll position across page switches, re-entry and refresh. Clearing a filter keeps the project scope, and **返回周计划** restores the week selected before opening the outline.

Expand a task to inspect original video titles and intervals, individually recorded practice steps, deliverables and notes. Saved progress remains visible after completion, with the record's latest update time. Correcting check-ins supports Undo; when a filtered-out task disappears, focus moves to Undo rather than another task's check-in button. Project scopes use milestone task IDs. Location history retains the progress phase, scope, expanded weeks and task outlines, and reading position.

Project acceptance is recorded separately from task check-ins, with an optional text record of code, demos or validation results. These records sync across devices and are included in version 3 backups. Restoring older backups retains existing acceptance records; clearing task check-ins leaves acceptance records unchanged.

Visible pages refresh remote progress periodically and when returning to the page. If another page or device updates a task or acceptance record while its draft is open, the draft stays available and saving requires choosing the latest record or the current draft. Full-backup restores retain a shared pending-replacement marker across tabs until the server confirms the restore.

The raw Yidaoyun catalogue stays outside the repository in `/root/eDaoYun/`. `week.totalMin` retains its meaning of original 0voice video minutes; `week.scheduledMinutes` sums all fixed work. The UI reports course completion separately from the later project target.
See [study-plan.md](study-plan.md) for the revised schedule and completion criteria.

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
