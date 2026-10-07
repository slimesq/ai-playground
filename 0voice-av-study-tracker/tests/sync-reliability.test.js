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

async function startServer(t, { oldSchema = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'av-sync-reliability-'));
  const dbPath = path.join(directory, 'tracker.db');
  const backupDir = path.join(directory, 'backups');
  if (oldSchema) {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE task_entries (task_id TEXT PRIMARY KEY, done INTEGER NOT NULL, updated_at TEXT NOT NULL)');
    db.prepare('INSERT INTO task_entries (task_id, done, updated_at) VALUES (?, ?, ?)')
      .run('legacy-zone', 1, '2026-10-01T00:00:00+08:00');
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
  let serverOutput = '';
  processHandle.stdout.on('data', chunk => { serverOutput += chunk; });
  processHandle.stderr.on('data', chunk => { serverOutput += chunk; });
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
    } catch { /* Wait for the isolated test server. */ }
    await delay(50);
  }
  assert.ok(ready, `Isolated server did not start: ${serverOutput}`);
  return { baseURL, dbPath, backupDir, stop };
}

async function sync(baseURL, entries, mode = 'merge') {
  const response = await fetch(`${baseURL}/api/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, state: { entries } })
  });
  return { status: response.status, body: await response.json() };
}

test('old SQLite rows migrate; offset timestamps, evidence, validation and backups survive sync', { timeout: 20_000 }, async t => {
  const server = await startServer(t, { oldSchema: true });
  const initial = await (await fetch(`${server.baseURL}/api/state`)).json();
  assert.deepEqual(initial.state.entries['legacy-zone'], {
    done: true, updatedAt: '2026-09-30T16:00:00.000Z', evidence: ''
  });

  const later = await sync(server.baseURL, {
    'legacy-zone': { done: false, updatedAt: '2026-09-30T17:00:00Z', evidence: '已重新核对' }
  });
  assert.equal(later.status, 200);
  assert.deepEqual(later.body.state.entries['legacy-zone'], {
    done: false, updatedAt: '2026-09-30T17:00:00.000Z', evidence: '已重新核对'
  });
  const invalidDone = await sync(server.baseURL, {
    'legacy-zone': { done: 'false', updatedAt: '2026-09-30T18:00:00Z' }
  });
  assert.equal(invalidDone.status, 400);
  assert.equal(invalidDone.body.error, 'INVALID_STATE');
  const invalidEvidence = await sync(server.baseURL, {
    'milestone:sample': { done: true, updatedAt: '2026-09-30T18:00:00Z', evidence: '字'.repeat(4001) }
  });
  assert.equal(invalidEvidence.status, 400);

  const replaced = await sync(server.baseURL, {
    'milestone:sample': { done: true, evidence: '演示录像与测试记录', updatedAt: '2027-01-01T00:00:00+08:00' },
    'legacy-string': '2027-01-01T01:00:00+08:00'
  }, 'replace');
  assert.equal(replaced.status, 200);
  assert.equal(Object.hasOwn(replaced.body.state.entries, 'legacy-zone'), false);
  assert.deepEqual(replaced.body.state.entries['milestone:sample'], {
    done: true, evidence: '演示录像与测试记录', updatedAt: '2026-12-31T16:00:00.000Z'
  });
  assert.deepEqual(replaced.body.state.entries['legacy-string'], {
    done: true, evidence: '', updatedAt: '2026-12-31T17:00:00.000Z'
  });

  await server.stop();
  const backups = (await fs.readdir(server.backupDir)).filter(name => name.endsWith('-shutdown.db'));
  assert.ok(backups.length > 0, 'Graceful shutdown makes an isolated SQLite backup');
  const backupDb = new DatabaseSync(path.join(server.backupDir, backups.at(-1)));
  try {
    const columns = backupDb.prepare('PRAGMA table_info(task_entries)').all();
    assert.ok(columns.some(column => column.name === 'evidence'));
    const row = backupDb.prepare('SELECT done, evidence, updated_at FROM task_entries WHERE task_id = ?').get('milestone:sample');
    assert.equal(row.done, 1);
    assert.equal(row.evidence, '演示录像与测试记录');
    assert.equal(row.updated_at, '2026-12-31T16:00:00.000Z');
  } finally { backupDb.close(); }
});

test('browser rejects false sync success, retries transient failures and stops on 401', { timeout: 20_000 }, async t => {
  const server = await startServer(t);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  let mode = 'ok';
  let syncCalls = 0;
  await page.route('**/api/sync', route => {
    syncCalls++;
    if (mode === 'html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>not the API</html>' });
    if (mode === 'incomplete') return route.fulfill({ json: { state: { entries: {} }, serverTime: new Date().toISOString() } });
    if (mode === 'unavailable') return route.fulfill({ status: 503, json: { message: 'Temporary outage' } });
    if (mode === 'unauthorized') return route.fulfill({ status: 401, json: { message: 'Wrong key' } });
    const entries = route.request().postDataJSON().state.entries;
    return route.fulfill({ json: { state: { entries }, serverTime: new Date().toISOString() } });
  });
  await page.goto(server.baseURL);
  await page.waitForFunction(() => syncState.status === '进度已同步');
  await page.evaluate(() => {
    state.entries['audit-probe'] = { done: true, evidence: '隔离测试', updatedAt: new Date().toISOString() };
    saveState();
  });

  mode = 'html';
  await page.evaluate(() => syncToServer({ silent: true }));
  assert.equal(await page.evaluate(() => syncState.status), '同步未完成，进度保留在本机');
  assert.equal(await page.evaluate(() => syncRetryTimer !== null), true);
  mode = 'ok';
  await page.waitForFunction(() => syncState.status === '进度已同步' && !activeSyncPromise, { timeout: 5000 });

  mode = 'incomplete';
  await page.evaluate(() => syncToServer({ silent: true }));
  assert.equal(await page.evaluate(() => syncState.status), '同步未完成，进度保留在本机');
  mode = 'unavailable';
  await page.waitForFunction(() => syncRetryAttempt >= 2, { timeout: 5000 });
  mode = 'ok';
  await page.waitForFunction(() => syncState.status === '进度已同步' && !activeSyncPromise, { timeout: 8000 });

  mode = 'unauthorized';
  await page.evaluate(() => syncToServer({ silent: true }));
  assert.equal(await page.evaluate(() => syncState.status), '同步口令不正确');
  assert.equal(await page.evaluate(() => syncRetryTimer), null);
  const callsAt401 = syncCalls;
  await delay(1200);
  assert.equal(syncCalls, callsAt401, 'Wrong key does not schedule automatic retries');
});
