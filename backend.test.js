import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

let app, server, base, cookie;
before(async () => {
  process.env.SESSION_SECRET = 'test-secret';
  ({ app } = createApp({ dbPath: ':memory:', syncToken: 'spreadsheet-test' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  cookie = '';
});

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('cookie', cookie);
  const res = await fetch(base + path, { ...options, headers });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const body = await res.json().catch(() => null);
  return { res, body };
}
const json = (body) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('health and session are public while data routes require signed session', async () => {
  assert.equal((await request('/healthz')).res.status, 200);
  assert.equal((await request('/api/overview')).res.status, 401);
  const signed = await request('/api/register', {
    method: 'POST',
    ...json({
      name: 'Nok',
      org: 'EMS',
      duty: 'Medic',
      opZone: 'triage',
    }),
  });
  assert.equal(signed.res.status, 201);
  assert.equal(signed.body.staff.name, 'Nok');
  assert.match(signed.body.username, /^NokEMS[0-9]{3}$/);
  assert.equal((await request('/api/overview')).body.patients.length, 4);
});

test('creates history, rejects stale updates, and keeps canonical sparse IDs', async () => {
  await request('/api/register', {
    method: 'POST',
    ...json({
      name: 'Nok',
      org: 'EMS',
      duty: 'Medic',
      opZone: 'triage',
    }),
  });
  const created = await request('/api/patients', {
    method: 'POST',
    ...json({
      id: 'MCI-123',
      color: 'red',
      zone: 'triage',
      triagePoint: 'primary',
      deconStatus: 'none',
      demo: 'yes',
      cc: 'pain',
      rr: '20',
      hr: '90',
      bp: '120/80',
      spo2: '98',
      gcs: '15',
      interventions: ['oxygen'],
      transport: 'ambulance',
      note: 'first',
    }),
  });
  assert.equal(created.res.status, 201);
  assert.equal(created.body.patient.id, 'MCI-123');
  assert.equal(created.body.history.length, 1);
  const version = created.body.patient.version;
  assert.equal(
    (
      await request('/api/patients/MCI-123', {
        method: 'PATCH',
        ...json({
          version,
          color: 'yellow',
          zone: 'treatment',
          note: 'second',
        }),
      })
    ).res.status,
    200,
  );
  const conflict = await request('/api/patients/MCI-123', {
    method: 'PATCH',
    ...json({ version, color: 'green' }),
  });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.body.error, 'stale version');
  assert.equal((await request('/api/patients/MCI-123')).body.history.length, 2);
  assert.equal(
    (
      await request('/api/patients', {
        method: 'POST',
        ...json({ id: 'MCI-123', color: 'red', zone: 'triage' }),
      })
    ).res.status,
    409,
  );
});

test('stock cannot become negative and reset preserves six seeded items', async () => {
  await request('/api/register', {
    method: 'POST',
    ...json({
      name: 'A',
      org: 'O',
      duty: 'D',
      opZone: 'triage',
    }),
  });
  const overview = await request('/api/overview');
  assert.equal(overview.body.stock.length, 6);
  const item = overview.body.stock[0];
  assert.equal(
    (
      await request(`/api/stock/${item.id}`, {
        method: 'PATCH',
        ...json({ delta: -(item.qty + 1) }),
      })
    ).res.status,
    400,
  );
  assert.equal(
    (await request('/api/stock/reset', { method: 'POST', ...json({}) })).body
      .stock.length,
    6,
  );
});

test('QR endpoint accepts an unused canonical card ID without exposing secrets', async () => {
  await request('/api/register', {
    method: 'POST',
    ...json({
      name: 'QR',
      org: 'EMS',
      duty: 'Medic',
      opZone: 'Primary Triage',
    }),
  });
  const qr = await fetch(base + '/api/qr/MCI-999.png', { headers: { cookie } });
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');
});

test('automatic numbers remain sequential after a sparse card and simultaneous intake', async () => {
  await request('/api/register', {
    method: 'POST',
    ...json({
      name: 'Nok',
      org: 'EMS',
      duty: 'Medic',
      opZone: 'Primary Triage',
    }),
  });
  const body = json({ color: 'green', zone: 'triage' });
  const responses = await Promise.all([
    request('/api/patients', { method: 'POST', ...body }),
    request('/api/patients', { method: 'POST', ...body }),
  ]);
  assert.deepEqual(responses.map(({ body }) => body.patient.id).sort(), [
    'MCI-005',
    'MCI-006',
  ]);
  assert.equal((await request('/api/patients/MCI-000')).res.status, 400);
  assert.equal((await request('/api/patients/MCI-0001')).res.status, 400);
});

test('a cleared exercise remains empty when its SQLite database reopens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mci-test-'));
  try {
    const dbPath = join(dir, 'exercise.sqlite');
    const first = createApp({ dbPath }).db;
    first.exec('DELETE FROM history; DELETE FROM patients;');
    first.close();
    const next = createApp({ dbPath }).db;
    try {
      assert.equal(
        next.prepare('SELECT count(*) AS count FROM patients').get().count,
        0,
      );
    } finally {
      next.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Google Sheets creates, updates and archives records in the actual database with scoped IDs', async () => {
  const excel = (path, body) =>
    request(
      `/api/sheets/${path}`,
      body
        ? {
            method: 'POST',
            ...json(body),
            headers: {
              ...json(body).headers,
              Authorization: 'Bearer spreadsheet-test',
            },
          }
        : { headers: { Authorization: 'Bearer spreadsheet-test' } },
    );
  const batch = (requestId, data) =>
    excel('changes', { requestId, incidentId: 'legacy', ...data });
  const registered = await batch('account-1', {
    accounts: [
      {
        Action: 'CREATE',
        incidentId: 'legacy',
        name: 'ต่อ',
        org: 'ทีมจำลอง',
        duty: 'Medic',
        opZone: 'triage',
      },
    ],
  });
  assert.equal(registered.res.status, 200);
  const account = registered.body.applied.accounts[0].record;
  const created = await batch('patient-1', {
    patients: [
      {
        Action: 'CREATE',
        incidentId: 'legacy',
        id: 'MCI-010',
        color: 'green',
        zone: 'triage',
      },
    ],
  });
  assert.equal(created.res.status, 200);
  const edit = {
    Action: 'UPDATE',
    incidentId: 'legacy',
    id: 'MCI-010',
    entityId: 'legacy:MCI-010',
    version: 1,
    zone: 'treatment',
  };
  assert.equal(
    (
      await batch('invalid-transaction', {
        patients: [edit],
        accounts: [
          {
            Action: 'UPDATE',
            incidentId: 'legacy',
            accountId: account.id,
            version: 99,
            opZone: 'treatment',
          },
        ],
      })
    ).res.status,
    409,
  );
  assert.equal(
    (await excel('snapshot')).body.patients.find((row) => row.id === 'MCI-010')
      .zone,
    'triage',
  );
  assert.equal(
    (await batch('valid-update', { patients: [edit] })).res.status,
    200,
  );
  assert.equal(
    (await excel('snapshot')).body.patients.find((row) => row.id === 'MCI-010')
      .zone,
    'treatment',
  );
  const login = await request('/api/session', {
    method: 'POST',
    ...json({ username: account.username }),
  });
  assert.equal(login.res.status, 200);
  assert.equal(
    (
      await batch('delete-both', {
        patients: [{ ...edit, Action: 'DELETE', version: 2 }],
        accounts: [
          {
            Action: 'DELETE',
            incidentId: 'legacy',
            accountId: account.id,
            version: 1,
          },
        ],
      })
    ).res.status,
    200,
  );
  assert.equal((await request('/api/overview')).res.status, 401);
  const after = (await excel('snapshot')).body;
  assert.equal(
    after.patients.some((row) => row.id === 'MCI-010'),
    false,
  );
  assert.equal(
    after.accounts.some((row) => row.id === account.id),
    false,
  );
});
