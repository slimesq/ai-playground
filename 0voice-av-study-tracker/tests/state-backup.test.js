'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'study-tracker.html'), 'utf8');
const data = JSON.parse(html.match(/const DATA\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/)[1]);
const source = fs.readFileSync(path.join(root, 'tracker-ui.js'), 'utf8').replace(/\ninit\(\);\s*$/, '\n');
function run(expression, input) {
  const sandbox = vm.createContext({ DATA: data, input, console, localStorage: {getItem: () => null} });
  vm.runInContext(source, sandbox);
  return JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, sandbox));
}
const stamp = '2026-09-30T00:00:00Z';
const first = data.weeks[0].tasks[0].id;
test('backup restores project evidence separately from task completion without affecting counts', () => {
  const record = {done:true,updatedAt:stamp,evidence:'代码：https://example.test/repo\n演示：已验证异常重连'};
  const report = run('importStateWithReport(input)', {version:3,entries:{[first]:{done:false,updatedAt:stamp}},milestoneReviews:{yibo:record}});
  assert.equal(report.matched,1);
  assert.equal(report.reviewsMatched,1);
  assert.equal(report.unmatched,0);
  assert.equal(report.entries[first].done,false);
  assert.equal(report.entries['milestone:yibo'].done,true);
  assert.equal(report.entries['milestone:yibo'].evidence,record.evidence);
  assert.equal(report.entries['milestone:yibo'].updatedAt,'2026-09-30T00:00:00.000Z');
  const legacy = run('importStateWithReport(input)', {version:2,entries:{[first]:{done:true,updatedAt:stamp}}});
  assert.equal(legacy.reviewsMatched,0,'Old backups have no authority to clear existing acceptance');
});
test('malformed imported completion and evidence are rejected instead of becoming completed tasks', () => {
  for (const record of [
    {done:'false',updatedAt:stamp}, {done:1,updatedAt:stamp}, {done:false,updatedAt:'invalid'},
    {done:true,updatedAt:stamp,evidence:{url:'invalid'}}, {done:true,updatedAt:stamp,evidence:'x'.repeat(4001)}
  ]) {
    assert.equal(run('(() => { try { importStateWithReport(input); return false; } catch { return true; } })()', {entries:{[first]:record}}),true);
    assert.equal(run('(() => { try { importStateWithReport(input); return false; } catch { return true; } })()', {milestoneReviews:{yibo:record}}),true);
  }
  const normalized = run('normalizeState(input)', {done:{[first]:false,'bad':'false'},checkins:{'2026-05-04':'false'}});
  assert.equal(normalized.entries[first].done,false);
  assert.equal(Object.keys(normalized.entries).length,1);
});
test('valid legacy dates normalize to UTC and retain independent project acceptance records', () => {
  const result = run('normalizeState(input)', {entries:{[first]:'2026-10-01T00:00:00+08:00','milestone:yibo':{done:false,updatedAt:'2026-10-01T00:00:00+08:00',evidence:'待补一个异常用例'}}});
  assert.equal(result.entries[first].updatedAt,'2026-09-30T16:00:00.000Z');
  assert.equal(result.entries['milestone:yibo'].done,false);
  assert.equal(result.entries['milestone:yibo'].evidence,'待补一个异常用例');
});
