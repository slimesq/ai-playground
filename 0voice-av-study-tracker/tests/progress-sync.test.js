'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { chromium } = require('playwright');

const PROJECT_DIR = path.resolve(__dirname, '..');

async function unusedPort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function startServer(t, { legacy = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'av-progress-sync-'));
  const dbPath = path.join(directory, 'tracker.db');
  const backupDir = path.join(directory, 'backups');
  if (legacy) {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE task_entries (task_id TEXT PRIMARY KEY, done INTEGER NOT NULL, updated_at TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT \'\')');
    db.prepare('INSERT INTO task_entries (task_id, done, updated_at, evidence) VALUES (?, ?, ?, ?)')
      .run('legacy', 0, '2026-09-30T00:00:00Z', '');
    db.close();
  }
  const port = await unusedPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const processHandle = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: String(port), TRACKER_API_KEY: '', DB_PATH: dbPath,
      BACKUP_DIR: backupDir, BACKUP_INTERVAL_MINUTES: '60', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  processHandle.stdout.on('data', chunk => { output += chunk; });
  processHandle.stderr.on('data', chunk => { output += chunk; });
  const stop = async () => {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) return;
    const exited = once(processHandle, 'exit');
    processHandle.kill('SIGTERM');
    await Promise.race([exited, delay(5000).then(() => processHandle.kill('SIGKILL'))]);
  };
  t.after(async () => { await stop(); await fs.rm(directory, { recursive: true, force: true }); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) break;
    try {
      const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch { /* Wait for the isolated server. */ }
    await delay(50);
  }
  assert.ok(ready, `Isolated server did not start: ${output}`);
  return { baseURL, dbPath, backupDir, stop };
}

async function postSync(baseURL, entries, mode = 'merge') {
  const response = await fetch(`${baseURL}/api/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, state: { entries } })
  });
  return { status: response.status, body: await response.json() };
}

async function openBrowser(t) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  return browser;
}

async function openReadyPage(context, baseURL) {
  const page = await context.newPage();
  await page.goto(baseURL);
  await page.waitForFunction(() => syncState.status === '进度已同步' && !activeSyncPromise);
  return page;
}

test('progress migrates into SQLite, rejects invalid records and survives the database backup', { timeout: 20_000 }, async t => {
  const server = await startServer(t, { legacy: true });
  const old = await (await fetch(`${server.baseURL}/api/state`)).json();
  assert.equal(old.state.entries.legacy.done, false);
  assert.equal(old.state.entries.legacy.progress, undefined);
  const stamp = '2026-10-01T00:00:00Z';
  const video = { kind: 'video', segmentIndex: 3, positionSecond: 1240, note: '看到编码同步' };
  const practice = { kind: 'practice', completedSteps: [0, 2], workedMinutes: 85, note: '已运行' };
  const saved = await postSync(server.baseURL, {
    video: { done: false, updatedAt: stamp, progress: video },
    practice: { done: false, updatedAt: stamp, progress: practice }
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.state.entries.video.progress, video);
  assert.deepEqual(saved.body.state.entries.practice.progress, practice);
  for (const progress of [
    { kind: 'video', positionSecond: 864001 },
    { kind: 'video', completedSteps: [0] },
    { kind: 'practice', completedSteps: [1, 1] },
    { kind: 'practice', note: '字'.repeat(1001) },
    { kind: 'practice', unknown: true }
  ]) {
    const invalid = await postSync(server.baseURL, { invalid: { done: false, updatedAt: stamp, progress } });
    assert.equal(invalid.status, 400, JSON.stringify(progress));
  }
  await server.stop();
  const files = await fs.readdir(server.backupDir);
  const shutdownBackup = files.find(name => name.endsWith('-shutdown.db'));
  assert.ok(shutdownBackup, 'shutdown should create a SQLite backup');
  const db = new DatabaseSync(path.join(server.backupDir, shutdownBackup));
  try {
    const row = db.prepare('SELECT progress FROM task_entries WHERE task_id = ?').get('practice');
    assert.deepEqual(JSON.parse(row.progress), practice);
  } finally { db.close(); }
});

test('returning to a visible long-open page pulls another device’s partial progress', { timeout: 20_000 }, async t => {
  const server = await startServer(t);
  const browser = await openBrowser(t);
  const a = await browser.newContext();
  const b = await browser.newContext();
  t.after(async () => { await a.close(); await b.close(); });
  const pageA = await openReadyPage(a, server.baseURL);
  const pageB = await openReadyPage(b, server.baseURL);
  const id = await pageA.evaluate(() => allTasks.find(task => task.activity === 'video' && task.segments?.length).id);
  await pageA.evaluate(async taskId => {
    state.entries[taskId] = createEntry(false, freshTimestamp(), '', { kind: 'video', segmentIndex: 0, positionSecond: 60 });
    localRevision++;
    saveState();
    await syncToServer({ silent: true });
  }, id);
  assert.equal(await pageB.evaluate(taskId => state.entries[taskId]?.progress, id), undefined);
  await pageB.evaluate(() => { lastVisibleSyncAt = 0; window.dispatchEvent(new Event('focus')); });
  await pageB.waitForFunction(taskId => state.entries[taskId]?.progress?.positionSecond === 60 && !activeSyncPromise, id);
  assert.equal(await pageB.evaluate(taskId => state.entries[taskId].done, id), false);
});

test('a delayed old replace response cannot re-send a stale backup after another tab acknowledges a newer generation', { timeout: 25_000 }, async t => {
  const server = await startServer(t);
  const browser = await openBrowser(t);
  const context = await browser.newContext();
  t.after(() => context.close());
  const a = await openReadyPage(context, server.baseURL);
  const b = await context.newPage();
  await b.addInitScript(() => {
    const original = window.addEventListener.bind(window);
    window.addEventListener = (type, listener, options) => original(type, type === 'storage'
      ? event => { if (!window.__holdStorageEvents) listener(event); } : listener, options);
  });
  await b.goto(server.baseURL);
  await b.waitForFunction(() => syncState.status === '进度已同步' && !activeSyncPromise);
  const id = await a.evaluate(() => allTasks[0].id);
  let releaseOld;
  const oldResponseGate = new Promise(resolve => { releaseOld = resolve; });
  let oldRequestStarted;
  const oldRequest = new Promise(resolve => { oldRequestStarted = resolve; });
  const modes = [];
  await b.route('**/api/sync', async route => {
    const mode = route.request().postDataJSON().mode;
    modes.push(mode);
    if (modes.length === 1 && mode === 'replace') {
      const response = await route.fetch();
      oldRequestStarted();
      await oldResponseGate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await a.evaluate(taskId => {
      state.entries[taskId] = createEntry(false, freshTimestamp());
      beginReplacement();
      saveState();
    }, id);
    await oldRequest;
    await b.evaluate(() => { window.__holdStorageEvents = true; });
    await a.evaluate(async taskId => {
      state.entries[taskId] = createEntry(true, freshTimestamp());
      localRevision++;
      saveState();
      await syncToServer({ silent: true, replace: true });
    }, id);
    assert.equal(await a.evaluate(() => readReplaceMarker().status), 'ack');
    releaseOld();
    await b.waitForFunction(taskId => state.entries[taskId]?.done === true && !state.pendingReplace && !activeSyncPromise, id);
    assert.deepEqual(modes.slice(0, 2), ['replace', 'merge']);
    const remote = await (await fetch(`${server.baseURL}/api/state`)).json();
    assert.equal(remote.state.entries[id].done, true);
  } finally { releaseOld(); }
});

test('an unsent full restore stays pending after a sibling tab saves locally', { timeout: 20_000 }, async t => {
  const server = await startServer(t);
  const browser = await openBrowser(t);
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addInitScript(() => { Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true }); });
  const a = await openReadyPage(context, server.baseURL);
  const b = await openReadyPage(context, server.baseURL);
  const ids = await a.evaluate(() => allTasks.slice(0, 2).map(task => task.id));
  for (const page of [a, b]) {
    await page.route('**/api/sync', route => route.fulfill({ status: 400, json: { message: 'isolated replace failure' } }));
  }
  await a.evaluate(([first, second]) => {
    const stamp = freshTimestamp();
    state.entries[first] = createEntry(false, stamp);
    state.entries[second] = createEntry(false, stamp);
    beginReplacement();
    saveState();
    syncToServer({ silent: true, replace: true });
  }, ids);
  await b.waitForFunction(first => state.pendingReplace && !!state.entries[first] && !activeSyncPromise, ids[0]);
  await b.evaluate(second => {
    state.entries[second] = createEntry(true, freshTimestamp());
    localRevision++;
    saveState();
  }, ids[1]);
  const marker = await b.evaluate(() => readReplaceMarker());
  assert.equal(marker.status, 'pending');
  assert.equal(marker.entries[ids[1]].done, true);
  assert.equal(await b.evaluate(() => JSON.parse(localStorage.getItem(STORE_KEY)).pendingReplace), true);
  await Promise.all([a.close(), b.close()]);
  await postSync(server.baseURL, { [ids[0]]: { done: true, updatedAt: '2030-01-01T00:00:00Z' } });
  const c = await context.newPage();
  const modes = [];
  c.on('request', request => { if (request.url().endsWith('/api/sync')) modes.push(request.postDataJSON().mode); });
  await c.goto(server.baseURL);
  await c.waitForFunction(() => syncState.status === '进度已同步' && !activeSyncPromise);
  assert.equal(modes[0], 'replace');
  const remote = await (await fetch(`${server.baseURL}/api/state`)).json();
  assert.equal(remote.state.entries[ids[0]].done, false);
  assert.equal(remote.state.entries[ids[1]].done, true);
});
