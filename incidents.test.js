import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import {
  initIncidents,
  registerIncidentRoutes,
  triageReview,
} from '../src/incidents.js';

let db, app, server, base;
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE patients (id TEXT PRIMARY KEY, color TEXT NOT NULL, zone TEXT NOT NULL, triagePoint TEXT NOT NULL, deconStatus TEXT NOT NULL, demo TEXT NOT NULL, cc TEXT NOT NULL, rr TEXT NOT NULL, hr TEXT NOT NULL, bp TEXT NOT NULL, spo2 TEXT NOT NULL, gcs TEXT NOT NULL, interventions TEXT NOT NULL, transport TEXT NOT NULL, version INTEGER NOT NULL, staff TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE history (seq INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL, note TEXT NOT NULL, staff TEXT NOT NULL, updatedAt TEXT NOT NULL, color TEXT NOT NULL, zone TEXT NOT NULL, triagePoint TEXT NOT NULL, deconStatus TEXT NOT NULL, rr TEXT NOT NULL, hr TEXT NOT NULL, bp TEXT NOT NULL, spo2 TEXT NOT NULL, gcs TEXT NOT NULL, interventions TEXT NOT NULL, transport TEXT NOT NULL);
    CREATE TABLE stock (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, qty INTEGER NOT NULL, unit TEXT NOT NULL, minAlert INTEGER NOT NULL, updatedAt TEXT NOT NULL, staff TEXT NOT NULL);
    INSERT INTO patients VALUES ('MCI-001','red','triage','primary','none','','','','','','','15','[]','',1,'Nok','2026-01-01');
    INSERT INTO history (patientId,note,staff,updatedAt,color,zone,triagePoint,deconStatus,rr,hr,bp,spo2,gcs,interventions,transport) VALUES ('MCI-001','old','Nok','2026-01-01','red','triage','primary','none','','','','','15','[]','');
    INSERT INTO stock VALUES ('STK-01','O2','Airway',2,'ชุด',0,'2026-01-01','system');
    PRAGMA user_version=1;`);
  initIncidents(db);
  app = express();
  app.use(express.json());
  const auth = (req, _res, next) => {
    req.staff = { name: 'Nok', org: 'EMS', duty: 'Medic', opZone: 'triage' };
    next();
  };
  registerIncidentRoutes(app, { db, auth, staffLabel: (s) => s.name });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('migrates v1 rows into legacy without changing identifiers, history sequence or stock quantity', async () => {
  assert.equal(
    db.prepare('SELECT id,incidentId FROM patients').get().id,
    'MCI-001',
  );
  assert.equal(db.prepare('SELECT seq FROM history').get().seq, 1);
  assert.equal(db.prepare('SELECT qty,incidentId FROM stock').get().qty, 2);
  assert.equal(
    db.prepare('SELECT user_version FROM pragma_user_version').get()
      .user_version,
    2,
  );
});

test('creates an incident and rejects mutations after it is closed', async () => {
  let response = await fetch(`${base}/api/incidents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Drill 2' }),
  });
  assert.equal(response.status, 201);
  const incident = (await response.json()).incident;
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM stock WHERE incidentId=?')
      .get(incident.id).n,
    6,
  );
  response = await fetch(`${base}/api/incidents/${incident.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'closed' }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-incident-id': incident.id,
    },
    body: JSON.stringify({ color: 'green', zone: 'triage', triagePoint: '' }),
  });
  assert.equal(response.status, 409);
});

test('isolates the same patient and stock IDs across incidents and reports history triage changes', async () => {
  let response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'MCI-002',
      color: 'green',
      zone: 'triage',
      triagePoint: 'primary',
    }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  response = await fetch(`${base}/api/patients/MCI-002`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: created.patient.version,
      color: 'yellow',
      triagePoint: 'secondary',
    }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/incidents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Second' }),
  });
  const second = (await response.json()).incident;
  response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-incident-id': second.id },
    body: JSON.stringify({
      id: 'MCI-002',
      color: 'red',
      zone: 'triage',
      triagePoint: 'primary',
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(
    db.prepare("SELECT count(*) n FROM patients WHERE id='MCI-002'").get().n,
    2,
  );
  response = await fetch(`${base}/api/overview`);
  const overview = await response.json();
  assert.equal(response.status, 200, JSON.stringify(overview));
  const review = overview.triageReview;
  assert.equal(review.matchedCases, 1);
  assert.equal(review.higherDirection, 1);
  assert.deepEqual(review.changes, [
    { id: 'MCI-002', primary: 'green', secondary: 'yellow' },
  ]);
  assert.equal(
    db.prepare('SELECT count(*) n FROM stock WHERE incidentId=?').get(second.id)
      .n,
    6,
  );
});

test('deducts stock exactly once with patient save and rolls back when insufficient', async () => {
  const body = {
    id: 'MCI-002',
    color: 'red',
    zone: 'triage',
    triagePoint: '',
    stockUsage: [{ stockId: 'STK-01', quantity: 1 }],
  };
  let response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'r1' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  assert.equal(
    db.prepare("SELECT qty FROM stock WHERE id='STK-01'").get().qty,
    1,
  );
  response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'r1' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.equal(
    db.prepare("SELECT count(*) n FROM patients WHERE id='MCI-002'").get().n,
    1,
  );
  response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'MCI-003',
      color: 'red',
      zone: 'triage',
      triagePoint: '',
      stockUsage: [{ stockId: 'STK-01', quantity: 2 }],
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(
    db.prepare("SELECT qty FROM stock WHERE id='STK-01'").get().qty,
    1,
  );
});

test('soft archives patient and legacy QR URL remains accepted', async () => {
  let response = await fetch(`${base}/api/patients/MCI-001`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(response.status, 200);
  assert.ok(
    db.prepare("SELECT deletedAt FROM patients WHERE id='MCI-001'").get()
      .deletedAt,
  );
  response = await fetch(`${base}/api/patients/MCI-001`);
  assert.equal(response.status, 200);
});

test('a paired black assessment counts toward coverage and not toward severity direction', () => {
  db.prepare(
    'UPDATE history SET color=? WHERE patientId=? AND triagePoint=?',
  ).run('black', 'MCI-001', 'primary');
  db.prepare(
    `
    INSERT INTO history (
      patientId, note, staff, updatedAt, color, zone, triagePoint, deconStatus,
      rr, hr, bp, spo2, gcs, interventions, transport, incidentId
    ) VALUES ('MCI-001','','ผู้ฝึกสอน','2026-11-26','red','triage','secondary','none','','','','','','[]','','legacy')
  `,
  ).run();
  const review = triageReview(db, 'legacy');
  assert.equal(review.primaryCases, 1);
  assert.equal(review.matchedCases, 1);
  assert.equal(review.coveragePercent, 100);
  assert.equal(review.withoutSecondary, 0);
  assert.equal(review.blackCases, 1);
  assert.equal(review.higherDirection, 0);
  assert.equal(review.lowerDirection, 0);
});
