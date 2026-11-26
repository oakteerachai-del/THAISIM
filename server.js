import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  createAccount,
  deleteAccount,
  initAccounts,
  listAccounts,
  registerAccountRoutes,
  updateAccount,
} from './accounts.js';
import * as incidents from './incidents.js';
import { registerSheetsRoutes } from './sheets-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOCK = [
  ['STK-01', 'Oxygen Tank + Mask', 'Airway', 20, 'ถัง', 5],
  ['STK-02', 'IV Set + 0.9% NSS', 'Circulation', 50, 'ชุด', 10],
  ['STK-03', 'Tourniquet / Gauze', 'Bleeding', 30, 'ชุด', 8],
  ['STK-04', 'Decon Wash Kit', 'Decontamination', 25, 'ชุด', 6],
  ['STK-05', 'C-Collar / Spine Board', 'Immobilization', 12, 'ชุด', 3],
  ['STK-06', 'Cold Pack / Dressing', 'General', 40, 'ชิ้น', 10],
];
const SEED = [
  [
    'MCI-001',
    'red',
    'triage',
    'primary',
    'none',
    'ผู้ร่วมซ้อม A',
    'หายใจลำบากหลังออกจากอาคาร',
    '24',
    '110',
    '90/60',
    '94',
    '13',
    ['O2 / Airway'],
    '',
  ],
  [
    'MCI-002',
    'yellow',
    'decon',
    'secondary',
    'pending',
    'ผู้ร่วมซ้อม B',
    'แผลบริเวณแขน รอชำระล้าง',
    '20',
    '98',
    '120/80',
    '98',
    '15',
    ['Stop Bleeding'],
    '',
  ],
  [
    'MCI-003',
    'green',
    'staging',
    '',
    'none',
    'ผู้ร่วมซ้อม C',
    'ถลอกเล็กน้อยที่ขา',
    '18',
    '82',
    '125/80',
    '99',
    '15',
    [],
    'รถฝึกซ้อม 01',
  ],
  [
    'MCI-004',
    'black',
    'morgue',
    '',
    'none',
    'ผู้ร่วมซ้อม D',
    'กรณีสมมติสำหรับฝึกบันทึกสีดำ',
    '',
    '',
    '',
    '',
    '3',
    [],
    'none',
  ],
];
const fields = [
  'color',
  'zone',
  'triagePoint',
  'deconStatus',
  'demo',
  'cc',
  'rr',
  'hr',
  'bp',
  'spo2',
  'gcs',
  'interventions',
  'transport',
];
const now = () => new Date().toISOString();
function dbPath(opts) {
  return (
    opts?.dbPath ||
    process.env.DB_PATH ||
    (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'mci.sqlite')
      : path.join(process.cwd(), 'mci.sqlite'))
  );
}

function initDb(db) {
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, color TEXT NOT NULL, zone TEXT NOT NULL, triagePoint TEXT NOT NULL, deconStatus TEXT NOT NULL, demo TEXT NOT NULL, cc TEXT NOT NULL, rr TEXT NOT NULL, hr TEXT NOT NULL, bp TEXT NOT NULL, spo2 TEXT NOT NULL, gcs TEXT NOT NULL, interventions TEXT NOT NULL, transport TEXT NOT NULL, version INTEGER NOT NULL, staff TEXT NOT NULL, updatedAt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL, note TEXT NOT NULL, staff TEXT NOT NULL, updatedAt TEXT NOT NULL, color TEXT NOT NULL, zone TEXT NOT NULL, triagePoint TEXT NOT NULL, deconStatus TEXT NOT NULL, rr TEXT NOT NULL, hr TEXT NOT NULL, bp TEXT NOT NULL, spo2 TEXT NOT NULL, gcs TEXT NOT NULL, interventions TEXT NOT NULL, transport TEXT NOT NULL); CREATE TABLE IF NOT EXISTS stock (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, qty INTEGER NOT NULL, unit TEXT NOT NULL, minAlert INTEGER NOT NULL, updatedAt TEXT NOT NULL, staff TEXT NOT NULL); CREATE TABLE IF NOT EXISTS staff (key TEXT PRIMARY KEY, name TEXT NOT NULL, org TEXT NOT NULL, duty TEXT NOT NULL, opZone TEXT NOT NULL);`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get();
    if (version === 0) {
      if (!db.prepare('SELECT 1 FROM patients LIMIT 1').get()) {
        for (const [id, ...values] of SEED) {
          const record = Object.fromEntries(
            fields.map((field, index) => [field, values[index]]),
          );
          insertPatient(db, record, id, 'ทีมจัดการฝึกซ้อม');
          addHistory(
            db,
            id,
            { ...record, note: 'เคสจำลองตั้งต้น' },
            'ทีมจัดการฝึกซ้อม',
          );
        }
      }
      if (!db.prepare('SELECT 1 FROM stock LIMIT 1').get())
        resetStock(db, 'ระบบ');
      db.exec('PRAGMA user_version=1');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function insertPatient(db, data, id, staff) {
  const t = now();
  db.prepare(
    'INSERT INTO patients VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    data.color || '',
    data.zone || 'triage',
    data.triagePoint || '',
    data.deconStatus || 'none',
    data.demo || '',
    data.cc || '',
    data.rr || '',
    data.hr || '',
    data.bp || '',
    data.spo2 || '',
    data.gcs || '',
    JSON.stringify(data.interventions || []),
    data.transport || '',
    1,
    staff,
    t,
  );
}
function resetStock(db, staff) {
  const t = now();
  db.exec('DELETE FROM stock');
  const q = db.prepare('INSERT INTO stock VALUES (?,?,?,?,?,?,?,?)');
  for (const [id, name, category, qty, unit, minAlert] of STOCK)
    q.run(id, name, category, qty, unit, minAlert, t, staff);
}
function addHistory(db, id, data, staff) {
  db.prepare(
    'INSERT INTO history (patientId,note,staff,updatedAt,color,zone,triagePoint,deconStatus,rr,hr,bp,spo2,gcs,interventions,transport) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    data.note || '',
    staff,
    now(),
    data.color || '',
    data.zone || '',
    data.triagePoint || '',
    data.deconStatus || '',
    data.rr || '',
    data.hr || '',
    data.bp || '',
    data.spo2 || '',
    data.gcs || '',
    JSON.stringify(data.interventions || []),
    data.transport || '',
  );
}

export function createApp(opts = {}) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is required');

  const filename = dbPath(opts);
  const db = opts.db || new DatabaseSync(filename);
  if (!opts.db && !opts.dbPath && process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    const { user_version: version } = db.prepare('PRAGMA user_version').get();
    const backup = path.join(
      path.dirname(filename),
      'mci-before-incident-migration.sqlite',
    );
    if (version === 1 && !existsSync(backup))
      db.prepare('VACUUM INTO ?').run(backup);
  }
  initDb(db);
  incidents.initIncidents(db);
  initAccounts(db);
  const app = express();
  const configuredOrigin =
    process.env.PUBLIC_ORIGIN ||
    (process.env.RAILWAY_PUBLIC_DOMAIN &&
      `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  const publicOrigin = configuredOrigin
    ? new URL(configuredOrigin).origin
    : null;
  const cookieOptions = `HttpOnly; SameSite=Lax; Path=/${publicOrigin?.startsWith('https:') ? '; Secure' : ''}`;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    const sameOrigin = publicOrigin || `${req.protocol}://${req.get('host')}`;
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      origin &&
      origin !== sameOrigin
    ) {
      return res.status(403).json({ error: 'คำขอมาจากเว็บไซต์อื่น' });
    }
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  const { auth, getOnlineCount } = registerAccountRoutes(app, {
    db,
    secret,
    cookieOptions,
    clock: opts.clock,
  });
  const staffLabel = (staff) =>
    [staff.name, staff.duty, staff.org, staff.opZone]
      .filter(Boolean)
      .join(' · ');
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  incidents.registerIncidentRoutes(app, {
    db,
    auth,
    getOnlineCount,
    staffLabel,
    publicOrigin,
  });
  const sheetsActor = 'Google Sheets';
  const sheetPatient = (patient) => ({
    ...patient,
    entityId: `${patient.incidentId}:${patient.id}`,
  });
  const saveSheetPatient = (row, isEdit) =>
    sheetPatient(
      incidents.savePatient(db, {
        scope: row.incidentId,
        data: row,
        actor: sheetsActor,
        id: typeof row.id === 'string' ? row.id.trim().toUpperCase() : '',
        version: row.version,
        isEdit,
        inTransaction: true,
      }).patient,
    );
  registerSheetsRoutes(app, {
    db,
    auth,
    syncToken: opts.syncToken ?? process.env.SHEETS_SYNC_TOKEN,
    sheetUrl: process.env.GOOGLE_SHEET_URL,
    listIncidents: () =>
      db
        .prepare(
          'SELECT id, name, createdAt AS openedAt, closedAt FROM incidents ORDER BY createdAt DESC',
        )
        .all(),
    listPatients: ({ incidentId }) =>
      db
        .prepare(
          `
      SELECT * FROM patients WHERE deletedAt IS NULL ${incidentId ? 'AND incidentId = ?' : ''}
      ORDER BY incidentId, length(id), id
    `,
        )
        .all(...(incidentId ? [incidentId] : []))
        .map((row) =>
          sheetPatient({
            ...row,
            interventions: JSON.parse(row.interventions),
          }),
        ),
    listAccounts: () => listAccounts(db),
    createPatient: (row) => saveSheetPatient(row, false),
    updatePatient: (row) => saveSheetPatient(row, true),
    deletePatient: (row) =>
      incidents.archivePatient(db, {
        scope: row.incidentId,
        id: row.id,
        version: row.version,
        actor: sheetsActor,
        inTransaction: true,
      }),
    createAccount: (row) => createAccount(db, row),
    updateAccount: (row) => updateAccount(db, row.accountId, row, row.version),
    deleteAccount: (row) => deleteAccount(db, row.accountId, row.version),
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/'))
      return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    next();
  });
  return { app, db };
}
export function startServer() {
  const { app } = createApp();
  return app.listen(Number(process.env.PORT || 3000), '0.0.0.0');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
