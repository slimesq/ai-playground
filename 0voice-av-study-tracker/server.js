require('dotenv').config();

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const TRACKER_API_KEY = String(process.env.TRACKER_API_KEY || '').trim();
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracker-state.json');
const APP_FILE = path.join(__dirname, 'study-tracker.html');

const app = express();

app.use(express.json({ limit: '1mb' }));

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

async function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    await fsp.writeFile(DATA_FILE, JSON.stringify(blankState(), null, 2), 'utf8');
  }
}

async function readState() {
  await ensureDataFile();
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    const fresh = blankState();
    await writeState(fresh);
    return fresh;
  }
}

async function writeState(state) {
  const normalized = normalizeState(state);
  normalized.updatedAt = latestUpdatedAt(normalized.entries);
  await ensureDataFile();
  await fsp.writeFile(DATA_FILE, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
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
    message: '缺少或错误的同步口令。'
  });
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    serverTime: new Date().toISOString()
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    authRequired: Boolean(TRACKER_API_KEY),
    serverTime: new Date().toISOString()
  });
});

app.get('/api/state', requireApiKey, async (req, res, next) => {
  try {
    const state = await readState();
    res.json({
      state,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sync', requireApiKey, async (req, res, next) => {
  try {
    const serverState = await readState();
    const clientState = normalizeState(req.body?.state || req.body || blankState());
    const merged = mergeStates(serverState, clientState);
    const saved = await writeState(merged);
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
  res.status(404).json({ error: 'NOT_FOUND', message: '请求的资源不存在。' });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({
    error: 'SERVER_ERROR',
    message: '服务器内部错误，请稍后再试。'
  });
});

app.listen(PORT, () => {
  console.log(`Study tracker server running at http://0.0.0.0:${PORT}`);
});
