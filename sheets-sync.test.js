import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { registerSheetsRoutes } from '../src/sheets-sync.js';

function harness() {
  const db = new DatabaseSync(':memory:');
  const patients = new Map();
  const app = express();
  app.use(express.json());
  const opts = {
    db,
    syncToken: 'secret',
    sheetUrl: 'https://docs.google.com/spreadsheets/d/synthetic_key/edit',
    auth: (req, res, next) =>
      req.headers['x-user'] === 'staff'
        ? next()
        : res.status(401).json({ error: 'auth' }),
    listPatients: ({ incidentId } = {}) =>
      [...patients.values()].filter(
        (p) => !incidentId || p.incidentId === incidentId,
      ),
    listAccounts: () => [],
    createPatient: (r) => {
      const row = { ...r, version: 1 };
      patients.set(r.entityId, row);
      return row;
    },
    updatePatient: (r) => {
      const old = patients.get(r.entityId);
      if (!old || old.version !== r.version)
        throw Object.assign(new Error('stale version'), {
          code: 'STALE_VERSION',
        });
      const row = { ...old, ...r, version: old.version + 1 };
      patients.set(r.entityId, row);
      return row;
    },
    deletePatient: (r) => {
      const old = patients.get(r.entityId);
      if (!old || old.version !== r.version)
        throw Object.assign(new Error('stale version'), {
          code: 'STALE_VERSION',
        });
      patients.delete(r.entityId);
    },
  };
  registerSheetsRoutes(app, opts);
  return { app, db, patients };
}
async function request(app, path, options = {}) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      {
        ...options,
        headers: {
          'content-type': 'application/json',
          ...(options.headers || {}),
        },
      },
    );
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('status is signed-in only and never exposes the sync token', async () => {
  const { app } = harness();
  assert.equal((await request(app, '/api/sheets/status')).status, 401);
  const r = await request(app, '/api/sheets/status', {
    headers: { 'x-user': 'staff' },
  });
  assert.deepEqual(r.body, {
    configured: true,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/synthetic_key/edit',
    lastSyncedAt: null,
  });
  assert.equal(JSON.stringify(r.body).includes('secret'), false);
});

test('snapshot requires bearer token and scopes patients by incident', async () => {
  const { app, patients } = harness();
  patients.set('drill-1:MCI-001', {
    entityId: 'drill-1:MCI-001',
    incidentId: 'drill-1',
    id: 'MCI-001',
    version: 3,
  });
  assert.equal((await request(app, '/api/sheets/snapshot')).status, 401);
  const r = await request(app, '/api/sheets/snapshot?incidentId=drill-1', {
    headers: { authorization: 'Bearer secret' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.patients[0].entityId, 'drill-1:MCI-001');
});

test('changes are idempotent and DELETE is explicit', async () => {
  const { app, db, patients } = harness();
  patients.set('drill-1:MCI-001', {
    entityId: 'drill-1:MCI-001',
    incidentId: 'drill-1',
    id: 'MCI-001',
    version: 1,
  });
  const body = {
    requestId: 'r1',
    incidentId: 'drill-1',
    patients: [
      {
        Action: 'UPDATE',
        entityId: 'drill-1:MCI-001',
        incidentId: 'drill-1',
        id: 'MCI-001',
        version: 1,
      },
      {
        Action: 'DELETE',
        entityId: 'drill-1:MCI-001',
        incidentId: 'drill-1',
        id: 'MCI-001',
        version: 2,
      },
    ],
  };
  const h = { authorization: 'Bearer secret' };
  const a = await request(app, '/api/sheets/changes', {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  });
  const b = await request(app, '/api/sheets/changes', {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  });
  assert.equal(a.status, 200);
  assert.deepEqual(b.body, a.body);
  assert.equal(patients.has('drill-1:MCI-001'), false);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM sheet_sync_requests').get().n,
    1,
  );
});

test('stale changes reject without applying later rows', async () => {
  const { app, patients } = harness();
  patients.set('drill-1:MCI-001', {
    entityId: 'drill-1:MCI-001',
    incidentId: 'drill-1',
    id: 'MCI-001',
    version: 2,
  });
  const r = await request(app, '/api/sheets/changes', {
    method: 'POST',
    headers: { authorization: 'Bearer secret' },
    body: JSON.stringify({
      requestId: 'r2',
      incidentId: 'drill-1',
      patients: [
        {
          Action: 'UPDATE',
          entityId: 'drill-1:MCI-001',
          incidentId: 'drill-1',
          id: 'MCI-001',
          version: 1,
        },
        {
          Action: 'CREATE',
          entityId: 'drill-1:MCI-002',
          incidentId: 'drill-1',
          id: 'MCI-002',
        },
      ],
    }),
  });
  assert.equal(r.status, 409);
  assert.equal(patients.has('drill-1:MCI-002'), false);
});
