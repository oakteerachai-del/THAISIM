import { createHash, timingSafeEqual } from 'node:crypto';

const actions = new Set(['CREATE', 'UPDATE', 'DELETE']);

function authorized(req, token) {
  const authorization = req.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return false;
  const actual = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validateChange(row, kind, incidentId) {
  if (!row || typeof row !== 'object' || row.incidentId !== incidentId) {
    throw new Error('รหัสเหตุการณ์ในรายการไม่ตรงกัน');
  }
  const Action = String(row.Action || '').toUpperCase();
  if (!actions.has(Action)) throw new Error('คำสั่งในชีตไม่ถูกต้อง');
  if (Action !== 'CREATE') {
    if (
      kind === 'patients' &&
      (!row.id || row.entityId !== `${incidentId}:${row.id}`)
    ) {
      throw new Error('รหัสแฟ้มผู้ป่วยไม่ตรงกับรหัสเหตุการณ์');
    }
    if (kind === 'accounts' && !row.accountId)
      throw new Error('กรุณาระบุ ID บัญชีเจ้าหน้าที่');
    if (!Number.isSafeInteger(row.version) || row.version < 1)
      throw new Error('ไม่พบรุ่นข้อมูลในชีต');
  }
  return { ...row, Action };
}

export function registerSheetsRoutes(
  app,
  {
    db,
    auth,
    syncToken,
    sheetUrl,
    listPatients,
    listAccounts,
    listIncidents = () => [],
    createPatient,
    updatePatient,
    deletePatient,
    createAccount,
    updateAccount,
    deleteAccount,
  },
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sheet_sync_requests (
      requestId TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      response TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sheet_sync_state (
      sheetId TEXT PRIMARY KEY,
      lastSyncedAt TEXT NOT NULL
    );
  `);

  function syncOnly(req, res, next) {
    if (!syncToken)
      return res.status(503).json({ error: 'ยังไม่ได้เปิดใช้ Google Sheets' });
    if (!authorized(req, syncToken))
      return res.status(401).json({ error: 'รหัสเชื่อมชีตไม่ถูกต้อง' });
    next();
  }

  const sheetId =
    /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/.exec(
      sheetUrl || '',
    )?.[1];
  app.get('/api/sheets/status', auth, (_req, res) => {
    const lastSyncedAt = sheetId
      ? db
          .prepare(
            'SELECT lastSyncedAt FROM sheet_sync_state WHERE sheetId = ?',
          )
          .get(sheetId)?.lastSyncedAt || null
      : null;
    res.json({
      configured: Boolean(syncToken && sheetId),
      sheetUrl: sheetId ? sheetUrl : null,
      lastSyncedAt,
    });
  });
  app.get('/api/sheets/snapshot', syncOnly, (req, res) => {
    const incidentId =
      typeof req.query.incidentId === 'string' ? req.query.incidentId : null;
    res.json({
      schemaVersion: 1,
      incidentId,
      generatedAt: new Date().toISOString(),
      patients: listPatients({ incidentId }),
      accounts: listAccounts(),
      incidents: listIncidents(),
    });
  });

  const operations = {
    patients: {
      CREATE: createPatient,
      UPDATE: updatePatient,
      DELETE: deletePatient,
    },
    accounts: {
      CREATE: createAccount,
      UPDATE: updateAccount,
      DELETE: deleteAccount,
    },
  };
  app.post('/api/sheets/changes', syncOnly, (req, res) => {
    const {
      requestId,
      incidentId,
      patients = [],
      accounts = [],
    } = req.body || {};
    if (
      typeof requestId !== 'string' ||
      !requestId ||
      requestId.length > 128 ||
      typeof incidentId !== 'string' ||
      !incidentId ||
      incidentId.length > 100 ||
      !Array.isArray(patients) ||
      !Array.isArray(accounts) ||
      patients.length + accounts.length > 250
    ) {
      return res.status(400).json({ error: 'รูปแบบรายการซิงก์ชีตไม่ถูกต้อง' });
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ incidentId, patients, accounts }))
      .digest('hex');
    const existing = db
      .prepare(
        'SELECT fingerprint, response FROM sheet_sync_requests WHERE requestId = ?',
      )
      .get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return res.status(409).json({ error: 'รายการนี้ถูกใช้ซิงก์ข้อมูลอื่นแล้ว' });
      return res.json(JSON.parse(existing.response));
    }
    let applied;
    db.exec('BEGIN IMMEDIATE');
    try {
      applied = { patients: [], accounts: [] };
      for (const [kind, rows] of Object.entries({ patients, accounts })) {
        for (const input of rows) {
          const row = validateChange(input, kind, incidentId);
          const record = operations[kind][row.Action](row, {
            incidentId,
            requestId,
          });
          const id =
            kind === 'patients'
              ? record?.entityId || row.entityId
              : record?.id || row.accountId;
          applied[kind].push({
            action: row.Action,
            id,
            ...(record ? { record } : {}),
          });
        }
      }
      db.prepare('INSERT INTO sheet_sync_requests VALUES (?, ?, ?, ?)').run(
        requestId,
        fingerprint,
        JSON.stringify({ ok: true, requestId, applied }),
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      const status =
        error.status ||
        (error.code === 'STALE_VERSION' || /stale version/i.test(error.message)
          ? 409
          : 400);
      return res.status(status).json({ error: error.message, requestId });
    }
    return res.json({ ok: true, requestId, applied });
  });
  app.post('/api/sheets/heartbeat', syncOnly, (req, res) => {
    if (!sheetId || req.body?.sheetId !== sheetId) {
      return res.status(400).json({ error: 'ไฟล์นี้ยังไม่ได้ตั้งเป็นชีตของ ThaiSIM' });
    }
    const lastSyncedAt = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO sheet_sync_state (sheetId, lastSyncedAt) VALUES (?, ?)
      ON CONFLICT(sheetId) DO UPDATE SET lastSyncedAt = excluded.lastSyncedAt
    `,
    ).run(sheetId, lastSyncedAt);
    res.json({ lastSyncedAt });
  });
}
