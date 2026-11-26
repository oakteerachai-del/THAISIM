import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initAccounts } from '../src/accounts.js';
import { createApp } from '../src/server.js';

const profile = {
  name: 'นก',
  org: 'EMS01',
  callSign: 'A1',
  personnelCode: '007',
  duty: 'Paramedic',
  opZone: 'Primary Triage',
};
let server;
let origin;
let time = Date.parse('2026-11-26T08:00:00Z');

before(async () => {
  process.env.SESSION_SECRET = 'tests-only';
  process.env.DEMO_PASSCODE = 'old-test-pass';
  const { app } = createApp({ dbPath: ':memory:', clock: () => time });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

async function request(path, { method = 'POST', body, cookie, incident } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (incident) headers['X-Incident-ID'] = incident;
  const response = await fetch(origin + path, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}

test('staff can register once and sign in with only their assigned username', async () => {
  const registered = await request('/api/register', { body: profile });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.username, 'นกEMS01007');
  const signedIn = await request('/api/session', {
    body: { username: 'นกems01007' },
  });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.staff.id, registered.body.staff.id);
  assert.equal(
    (await request('/api/session', { body: { username: 'missing' } })).status,
    401,
  );
  assert.equal(
    (await request('/api/register', { body: { ...profile, org: 'ems01' } }))
      .status,
    409,
  );
});

test('000 assigns a new sequential code to each registration', async () => {
  const missingCode = {
    ...profile,
    name: 'โดม',
    personnelCode: '000',
    callSign: '',
  };
  const first = await request('/api/register', { body: missingCode });
  const second = await request('/api/register', { body: missingCode });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.username, 'โดมEMS01001');
  assert.equal(second.body.username, 'โดมEMS01002');
});

test('username uses the last three code characters, even for longer staff IDs', async () => {
  const registered = await request('/api/register', {
    body: { ...profile, name: 'แอน', org: 'ทีม 2', personnelCode: 'EMP00987' },
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.username, 'แอนทีม2987');
  assert.equal(registered.body.staff.personnelCode, 'EMP00987');
});

test('presence counts staff once over multiple sessions and expires', async () => {
  const registered = await request('/api/register', {
    body: { ...profile, name: 'พลอย' },
  });
  assert.equal(registered.status, 201);
  const anotherTab = await request('/api/session', {
    body: { username: registered.body.username },
  });
  const heartbeat = (cookie) => request('/api/presence', { cookie, body: {} });
  assert.equal((await heartbeat(registered.cookie)).body.onlineStaffCount, 1);
  assert.equal((await heartbeat(anotherTab.cookie)).body.onlineStaffCount, 1);
  time += 91000;
  assert.equal(
    (
      await request('/api/overview', {
        method: 'GET',
        cookie: registered.cookie,
      })
    ).body.onlineStaffCount,
    0,
  );
  await heartbeat(registered.cookie);
  await request('/api/session', {
    method: 'DELETE',
    cookie: registered.cookie,
  });
  assert.equal(
    (
      await request('/api/overview', {
        method: 'GET',
        cookie: anotherTab.cookie,
      })
    ).body.onlineStaffCount,
    0,
  );
});

test('the login note advertises a working demo username', async () => {
  const anonymous = await request('/api/session', { method: 'GET' });
  assert.equal(anonymous.body.demoUsername, 'DemoThaiSIM001');
  const demo = await request('/api/session', {
    body: { username: anonymous.body.demoUsername },
  });
  assert.equal(demo.status, 200);
  assert.equal(demo.body.staff.name, 'Demo');
});

test('legacy accounts keep their IDs and original logins after compact-name collisions', async () => {
  const db = new DatabaseSync(':memory:');
  initAccounts(db);
  const insert =
    db.prepare(`INSERT INTO staff_accounts (id, username, usernameKey, name, org, callSign, personnelCode, duty, opZone, updatedAt)
    VALUES (?, ?, ?, 'มด', 'EMS 01', ?, '007', 'MD', 'Treatment', '2026-01-01')`);
  for (const callSign of ['A', 'B']) {
    const username = 'มด-EMS 01/' + callSign + '/007';
    insert.run(callSign, username, username.toLowerCase(), callSign);
  }
  const { app } = createApp({ db });
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((r) => listener.once('listening', r));
  try {
    const endpoint =
      'http://127.0.0.1:' + listener.address().port + '/api/session';
    const logIn = async (username) => {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      assert.equal(r.status, 200);
      return (await r.json()).staff;
    };
    const first = await logIn('มด-EMS 01/A/007');
    const second = await logIn('มด-EMS 01/B/007');
    assert.equal(first.username, 'มดEMS01007');
    assert.notEqual(first.username, second.username);
    assert.match(second.username, /^มดEMS01[0-9]{3}$/);
    initAccounts(db);
    assert.equal((await logIn(first.username)).id, 'A');
    assert.equal((await logIn(second.username)).id, 'B');
    assert.equal((await logIn(second.username)).version, 2);
  } finally {
    await new Promise((r) => listener.close(r));
    db.close();
  }
});
