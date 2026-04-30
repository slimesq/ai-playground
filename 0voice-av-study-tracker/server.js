require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { DatabaseSync, backup } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const TRACKER_API_KEY = String(process.env.TRACKER_API_KEY || '').trim();
const DATA_DIR = path.join(__dirname, 'data');
const LEGACY_JSON_FILE = path.join(DATA_DIR, 'tracker-state.json');
const DB_PATH = resolveDbPath(process.env.DB_PATH);
const BACKUP_DIR = resolveBackupDir(process.env.BACKUP_DIR);
const BACKUP_INTERVAL_MINUTES = readPositiveInt(process.env.BACKUP_INTERVAL_MINUTES, 360);
const BACKUP_RETENTION = readPositiveInt(process.env.BACKUP_RETENTION, 14);
const EXPOSE_HEALTH_PATHS = String(process.env.EXPOSE_HEALTH_PATHS || '').trim() === '1';
const APP_FILE = path.join(__dirname, 'study-tracker.html');

const app = express();
app.use(express.json({ limit: '1mb' }));

let db = null;
let backupTimer = null;
let backupInFlight = false;
let activeBackupPromise = null;
let shutdownPromise = null;
const backupStatus = {
  lastBackupAt: '',
  lastBackupPath: '',
  lastBackupReason: '',
  lastBackupError: ''
};

function resolveDbPath(rawPath) {
  if (!rawPath) {
    return path.join(DATA_DIR, 'tracker.db');
  }
  return path.isAbsolute(rawPath)
    ? rawPath
    : path.join(__dirname, rawPath);
}

function resolveBackupDir(rawPath) {
  if (!rawPath) {
    return path.join(DATA_DIR, 'backups');
  }
  return path.isAbsolute(rawPath)
    ? rawPath
    : path.join(__dirname, rawPath);
}

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function blankState() {
  return { version: 1, updatedAt: '', entries: {} };
}

function isValidIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function normalizeEntry(record) {
  if (typeof record === 'string') {
    return {
      done: true,
      updatedAt: isValidIso(record) ? record : new Date(0).toISOString()
    };
  }

  if (!record || typeof record !== 'object') {
    return null;
  }

  return {
    done: !!record.done,
    updatedAt: isValidIso(record.updatedAt)
      ? record.updatedAt
      : new Date(0).toISOString()
  };
}

function latestUpdatedAt(entries) {
  let latest = '';
  for (const record of Object.values(entries || {})) {
    if (record?.updatedAt && record.updatedAt > latest) {
      latest = record.updatedAt;
    }
  }
  return latest;
}

function normalizeState(data) {
  const state = blankState();
  if (data?.entries && typeof data.entries === 'object') {
    for (const [taskId, record] of Object.entries(data.entries)) {
      if (!taskId) continue;
      const normalized = normalizeEntry(record);
      if (normalized) {
        state.entries[taskId] = normalized;
      }
    }
  }
  state.updatedAt = isValidIso(data?.updatedAt)
    ? data.updatedAt
    : latestUpdatedAt(state.entries);
  return state;
}

function mergeStates(serverState, clientState) {
  const merged = blankState();
  const taskIds = new Set([
    ...Object.keys(serverState.entries || {}),
    ...Object.keys(clientState.entries || {})
  ]);

  for (const taskId of taskIds) {
    const serverRecord = normalizeEntry(serverState.entries?.[taskId]);
    const clientRecord = normalizeEntry(clientState.entries?.[taskId]);
    if (serverRecord && clientRecord) {
      merged.entries[taskId] =
        clientRecord.updatedAt > serverRecord.updatedAt
          ? clientRecord
          : serverRecord;
      continue;
    }
    merged.entries[taskId] = clientRecord || serverRecord;
  }

  merged.updatedAt = latestUpdatedAt(merged.entries);
  return merged;
}

function initDatabase() {
  ensureParentDir(DB_PATH);
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS task_entries (
      task_id TEXT PRIMARY KEY,
      done INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_entries_updated_at
      ON task_entries(updated_at);
  `);
  migrateLegacyJsonIfNeeded();
}

function databaseIsEmpty() {
  const row = db.prepare('SELECT COUNT(*) AS count FROM task_entries').get();
  return !row || Number(row.count) === 0;
}

function hasDataToProtect() {
  return !databaseIsEmpty();
}

function readLegacyJsonState() {
  if (!fs.existsSync(LEGACY_JSON_FILE)) {
    return blankState();
  }

  try {
    const raw = fs.readFileSync(LEGACY_JSON_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (error) {
    console.warn('Failed to read legacy JSON state:', error.message);
    return blankState();
  }
}

function writeEntries(entries) {
  const upsert = db.prepare(`
    INSERT INTO task_entries (task_id, done, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      done = excluded.done,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at >= task_entries.updated_at
  `);

  db.exec('BEGIN');
  try {
    for (const [taskId, record] of Object.entries(entries)) {
      upsert.run(taskId, record.done ? 1 : 0, record.updatedAt);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function writeEntriesWithinTransaction(entries) {
  const upsert = db.prepare(`
    INSERT INTO task_entries (task_id, done, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      done = excluded.done,
      updated_at = excluded.updated_at
    WHERE excluded.updated_at >= task_entries.updated_at
  `);

  for (const [taskId, record] of Object.entries(entries)) {
    upsert.run(taskId, record.done ? 1 : 0, record.updatedAt);
  }
}

function migrateLegacyJsonIfNeeded() {
  if (!databaseIsEmpty() || !fs.existsSync(LEGACY_JSON_FILE)) {
    return;
  }

  const legacyState = readLegacyJsonState();
  if (!Object.keys(legacyState.entries).length) {
    return;
  }

  writeEntries(legacyState.entries);
  console.log(`Imported legacy JSON state into SQLite: ${LEGACY_JSON_FILE}`);
}

function readState() {
  const rows = db.prepare(`
    SELECT task_id, done, updated_at
    FROM task_entries
  `).all();

  const state = blankState();
  for (const row of rows) {
    state.entries[row.task_id] = {
      done: !!row.done,
      updatedAt: row.updated_at
    };
  }
  state.updatedAt = latestUpdatedAt(state.entries);
  return state;
}

function replaceState(state) {
  const normalized = normalizeState(state);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM task_entries');
    writeEntriesWithinTransaction(normalized.entries);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return readState();
}

function writeState(state, options = {}) {
  if (options.replace) {
    return replaceState(state);
  }
  const normalized = normalizeState(state);
  writeEntries(normalized.entries);
  return readState();
}

function formatBackupStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function pruneBackups() {
  ensureParentDir(path.join(BACKUP_DIR, 'placeholder'));
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(name => /^tracker-\d{8}T\d{6}Z-[a-z]+\.db$/i.test(name))
    .sort()
    .reverse();

  for (const file of files.slice(BACKUP_RETENTION)) {
    fs.rmSync(path.join(BACKUP_DIR, file), { force: true });
  }
}

async function createBackup(reason) {
  if (backupInFlight) {
    return activeBackupPromise;
  }

  if (!hasDataToProtect()) {
    return null;
  }

  backupInFlight = true;
  const fileName = `tracker-${formatBackupStamp()}-${reason}.db`;
  const targetPath = path.join(BACKUP_DIR, fileName);

  activeBackupPromise = (async () => {
    try {
      ensureParentDir(targetPath);
      await backup(db, targetPath, { rate: 200 });
      pruneBackups();
      backupStatus.lastBackupAt = new Date().toISOString();
      backupStatus.lastBackupPath = targetPath;
      backupStatus.lastBackupReason = reason;
      backupStatus.lastBackupError = '';
      return targetPath;
    } catch (error) {
      backupStatus.lastBackupError = error.message;
      throw error;
    } finally {
      backupInFlight = false;
      activeBackupPromise = null;
    }
  })();

  return activeBackupPromise;
}

function scheduleBackups() {
  const intervalMs = BACKUP_INTERVAL_MINUTES * 60 * 1000;
  backupTimer = setInterval(() => {
    createBackup('scheduled').catch(error => {
      console.error('Scheduled backup failed:', error);
    });
  }, intervalMs);

  if (typeof backupTimer.unref === 'function') {
    backupTimer.unref();
  }
}

function registerShutdownHooks() {
  const shutdown = async (signal) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      let shouldTryShutdownBackup = true;
      try {
        if (activeBackupPromise) {
          try {
            await activeBackupPromise;
            shouldTryShutdownBackup = false;
          } catch (error) {
            console.error(`Active backup before ${signal} failed:`, error);
          }
        }
        if (shouldTryShutdownBackup) {
          await createBackup('shutdown');
        }
      } catch (error) {
        console.error(`Backup during ${signal} failed:`, error);
      } finally {
        process.exit(0);
      }
    })();

    try {
      await shutdownPromise;
    } catch (error) {
      console.error(`Shutdown during ${signal} failed:`, error);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

function requireApiKey(req, res, next) {
  if (!TRACKER_API_KEY) {
    return next();
  }

  const incoming = String(req.header('x-api-key') || '').trim();
  if (incoming && incoming === TRACKER_API_KEY) {
    return next();
  }

  return res.status(401).json({
    error: 'UNAUTHORIZED',
    message: 'Sync key missing or invalid.'
  });
}

app.get('/api/health', (req, res) => {
  const payload = {
    ok: true,
    serverTime: new Date().toISOString(),
    storage: 'sqlite',
    backupIntervalMinutes: BACKUP_INTERVAL_MINUTES,
    backupRetention: BACKUP_RETENTION,
    lastBackupAt: backupStatus.lastBackupAt,
    lastBackupReason: backupStatus.lastBackupReason,
    lastBackupError: backupStatus.lastBackupError
  };

  if (EXPOSE_HEALTH_PATHS) {
    payload.dbPath = DB_PATH;
    payload.backupDir = BACKUP_DIR;
    payload.lastBackupPath = backupStatus.lastBackupPath;
  }

  res.json(payload);
});

app.get('/api/config', (req, res) => {
  res.json({
    authRequired: Boolean(TRACKER_API_KEY),
    serverTime: new Date().toISOString(),
    storage: 'sqlite'
  });
});

app.get('/api/state', requireApiKey, (req, res, next) => {
  try {
    const state = readState();
    res.json({
      state,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sync', requireApiKey, (req, res, next) => {
  try {
    const serverState = readState();
    const clientState = normalizeState(req.body?.state || req.body || blankState());
    const replace = req.body?.mode === 'replace' || req.body?.replace === true;
    const merged = replace ? clientState : mergeStates(serverState, clientState);
    const saved = writeState(merged, { replace });
    res.json({
      state: saved,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

app.get('/', (req, res) => {
  res.sendFile(APP_FILE);
});

app.get('/study-tracker.html', (req, res) => {
  res.sendFile(APP_FILE);
});

app.use((req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: 'Resource not found.'
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({
    error: 'SERVER_ERROR',
    message: 'Internal server error.'
  });
});

initDatabase();
scheduleBackups();
registerShutdownHooks();

app.listen(PORT, () => {
  console.log(`Study tracker server running at http://0.0.0.0:${PORT}`);
  console.log(`SQLite file: ${DB_PATH}`);
  console.log(`Backup directory: ${BACKUP_DIR}`);
  console.log(`Backup interval: ${BACKUP_INTERVAL_MINUTES} minutes`);
  void createBackup('startup').catch(error => {
    console.error('Startup backup failed:', error);
  });
});
