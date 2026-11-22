// Run: node --experimental-sqlite --test tests/coupon20.test.mjs
// In-memory D1 compatibility test only; no Cloudflare or customer data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;

class Prepared {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Prepared(this.db, this.sql, args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}
class D1Mock {
  constructor(initial, generation = 0, active = 0) {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(
      'CREATE TABLE stamp_points (device_id TEXT PRIMARY KEY, current_points INTEGER NOT NULL, total_redeemed INTEGER NOT NULL, megami_coupon_active INTEGER NOT NULL);' +
      'CREATE TABLE coupon_operations_v1 (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, coupon_generation INTEGER NOT NULL, attempt_id TEXT NOT NULL, created_at TEXT DEFAULT (datetime(' +
      "'now'" + ')), UNIQUE (device_id, operation, request_id));'
    );
    this.sqlite.prepare('INSERT INTO stamp_points VALUES (?, ?, ?, ?)').run('dev', initial, generation, active);
  }
  prepare(sql) { return new Prepared(this.sqlite, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const out = statements.map(s => {
        const stmt = this.sqlite.prepare(s.sql);
        const rows = /^\s*SELECT\b|\bRETURNING\b/i.test(s.sql)
          ? stmt.all(...s.args) : (stmt.run(...s.args), []);
        return { results: rows };
      });
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) { this.sqlite.exec('ROLLBACK'); throw e; }
  }
  state() { return this.sqlite.prepare('SELECT * FROM stamp_points WHERE device_id = ?').get('dev'); }
  count() { return this.sqlite.prepare('SELECT COUNT(*) AS n FROM coupon_operations_v1').get().n; }
}
function fixture(initial, generation = 0, active = 0) {
  const db = new D1Mock(initial, generation, active);
  return { db, env: { DB: db, ADMIN_PASSWORD: 'test-only' } };
}
async function post(env, path, body) {
  const req = new Request('https://local.invalid' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const r = await worker.fetch(req, env);
  return { status: r.status, body: await r.json() };
}
function redeem(g, id) { return { device_id: 'dev', coupon_generation: g, request_id: id, required_points: 20 }; }
function use(g, id) { return { device_id: 'dev', coupon_generation: g, request_id: id }; }

for (const [before, status, after] of [[19, 409, 19], [20, 200, 0], [21, 200, 1], [22, 200, 2], [42, 200, 22]]) {
  test('redeem 20 only: ' + before + ' -> ' + after, async () => {
    const { db, env } = fixture(before, 2);
    const r = await post(env, '/redeem-points', redeem(2, 'request-' + before));
    assert.equal(r.status, status);
    assert.equal(db.state().current_points, after);
    assert.equal(db.state().total_redeemed, status === 200 ? 3 : 2);
    assert.equal(db.state().megami_coupon_active, status === 200 ? 1 : 0);
    assert.equal(db.count(), status === 200 ? 1 : 0);
  });
}

test('same request replay never spends another 20', async () => {
  const { db, env } = fixture(42, 7);
  assert.equal((await post(env, '/redeem-points', redeem(7, 'same'))).status, 200);
  const again = await post(env, '/redeem-points', redeem(7, 'same'));
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(db.state().current_points, 22);
  assert.equal(db.count(), 1);
});

test('20 distinct concurrent requests produce one award', async () => {
  const { db, env } = fixture(42, 0);
  const answers = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    post(env, '/redeem-points', redeem(0, 'concurrent-' + i))));
  assert.equal(answers.filter(r => r.status === 200).length, 1);
  assert.equal(answers.filter(r => r.status === 409).length, 19);
  assert.equal(db.state().current_points, 22);
  assert.equal(db.count(), 1);
});

test('use and retry leave remainder unchanged', async () => {
  const { db, env } = fixture(22, 3, 1);
  assert.equal((await post(env, '/megami-coupon/use', use(3, 'use-1'))).status, 200);
  assert.equal(db.state().current_points, 22);
  assert.equal(db.state().megami_coupon_active, 0);
  const again = await post(env, '/megami-coupon/use', use(3, 'use-1'));
  assert.equal(again.body.replayed, true);
  assert.equal(db.state().current_points, 22);
});

test('old use replay cannot consume the next coupon', async () => {
  const { db, env } = fixture(42);
  assert.equal((await post(env, '/redeem-points', redeem(0, 'r1'))).status, 200);
  assert.equal((await post(env, '/megami-coupon/use', use(1, 'u1'))).status, 200);
  assert.equal((await post(env, '/redeem-points', redeem(1, 'r2'))).status, 200);
  const repeated = await post(env, '/megami-coupon/use', use(1, 'u1'));
  assert.equal(repeated.body.replayed, true);
  assert.equal(db.state().current_points, 2);
  assert.equal(db.state().megami_coupon_active, 1);
});

test('legacy app cannot mutate points or active coupon', async () => {
  const a = fixture(20);
  assert.equal((await post(a.env, '/redeem-points', { device_id: 'dev', required_points: 20 })).status, 426);
  assert.equal(a.db.state().current_points, 20);
  const b = fixture(3, 1, 1);
  assert.equal((await post(b.env, '/megami-coupon/use', { device_id: 'dev' })).status, 426);
  assert.equal(b.db.state().megami_coupon_active, 1);
});

test('wrong amount and stale generation do not mutate', async () => {
  const { db, env } = fixture(42, 3);
  assert.equal((await post(env, '/redeem-points', { ...redeem(3, 'bad'), required_points: 30 })).status, 400);
  assert.equal((await post(env, '/redeem-points', redeem(2, 'old'))).status, 409);
  assert.equal(db.state().current_points, 42);
  assert.equal(db.count(), 0);
});
