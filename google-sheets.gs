/* ThaiSIM Google Sheets adapter. Keep this file in a private Apps Script project. */
var THAISIM_API = 'https://thaisim-mci-tracking-production.up.railway.app';
var SHEETS = { patients: 'ผู้ป่วย', accounts: 'เจ้าหน้าที่', incidents: 'เหตุการณ์' };
var PH = [
  'คำสั่ง',
  'ผลซิงก์',
  'รหัสผู้ป่วย',
  'รหัสเหตุการณ์',
  'สีคัดแยก',
  'จุดปฏิบัติงาน',
  'รอบคัดแยก',
  'สถานะชำระล้าง',
  'ข้อมูลสมมติผู้ป่วย',
  'อาการสำคัญ',
  'RR',
  'HR',
  'BP',
  'SpO₂',
  'GCS',
  'หัตถการ',
  'ปลายทาง',
  'คีย์ซิงก์',
  'รุ่นข้อมูล',
  'ข้อมูลก่อนแก้',
  'คีย์รายการใหม่',
];
var AH = [
  'คำสั่ง',
  'ผลซิงก์',
  'Username',
  'ชื่อเล่น',
  'สังกัด',
  'นามเรียกขาน',
  'รหัสบุคลากร',
  'หน้าที่',
  'โซนปฏิบัติงาน',
  'รหัสบัญชี',
  'คีย์ซิงก์',
  'รุ่นข้อมูล',
  'ข้อมูลก่อนแก้',
  'คีย์รายการใหม่',
];
var IH = ['รหัสเหตุการณ์', 'ชื่อเหตุการณ์', 'เวลาเปิด', 'เวลาปิด', 'จำนวนผู้ป่วย'];
var PF = [
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
var AF = ['name', 'org', 'callSign', 'personnelCode', 'duty', 'opZone'];

var DISPLAY = {
  color: { red: 'แดง', yellow: 'เหลือง', green: 'เขียว', black: 'ดำ' },
  zone: {
    triage: 'จุดคัดแยก',
    decon: 'จุดชำระล้าง',
    treatment: 'จุดรักษา',
    staging: 'จุดรอส่งต่อ',
    evacuated: 'ส่งต่อแล้ว',
    discharged: 'จำหน่ายแล้ว',
    morgue: 'จุดพักศพ',
  },
  triagePoint: { primary: 'Primary', secondary: 'Secondary' },
  deconStatus: {
    none: 'ไม่ต้องชำระล้าง',
    pending: 'รอชำระล้าง',
    'in-progress': 'กำลังชำระล้าง',
    cleared: 'ชำระล้างแล้ว',
  },
};

function thaiSimConfig_() {
  var properties = PropertiesService.getScriptProperties();
  var id = properties.getProperty('THAISIM_SPREADSHEET_ID');
  var token = properties.getProperty('THAISIM_SYNC_TOKEN');
  if (!id || !token) throw new Error('ตั้งค่า Spreadsheet ID และ Sync token ก่อน');
  return { id, token };
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ThaiSIM')
    .addItem('ซิงก์ตอนนี้', 'syncThaiSimNow')
    .addToUi();
}

function installThaiSimTriggers() {
  var config = thaiSimConfig_();
  var workbook = SpreadsheetApp.openById(config.id);
  syncThaiSimNow();
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (
      ['thaiSimEditTrigger', 'thaiSimClockTrigger'].includes(
        trigger.getHandlerFunction(),
      )
    ) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('thaiSimEditTrigger')
    .forSpreadsheet(workbook)
    .onEdit()
    .create();
  ScriptApp.newTrigger('thaiSimClockTrigger')
    .timeBased()
    .everyMinutes(1)
    .create();
}

function thaiSimEditTrigger(event) {
  if (
    event.range.getRow() > 1 &&
    [SHEETS.patients, SHEETS.accounts].includes(
      event.range.getSheet().getName(),
    )
  ) {
    syncThaiSimNow();
  }
}

function thaiSimClockTrigger() {
  syncThaiSimNow();
}

function thaiSimRequest_(config, path, body) {
  var options = {
    method: body === undefined ? 'get' : 'post',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + config.token },
    contentType: 'application/json',
  };
  if (body !== undefined) options.payload = JSON.stringify(body);
  var response;
  try {
    response = UrlFetchApp.fetch(THAISIM_API + '/api/sheets/' + path, options);
  } catch (_) {
    throw Object.assign(new Error('เครือข่ายขัดข้อง กำลังรอลองซิงก์อีกครั้ง'), {
      uncertain: true,
    });
  }
  var data;
  try {
    data = JSON.parse(response.getContentText());
  } catch (_) {
    throw new Error('ThaiSIM ตอบกลับ HTTP ' + response.getResponseCode());
  }
  if (response.getResponseCode() >= 300) {
    throw Object.assign(new Error(data.error || 'ซิงก์ไม่สำเร็จ'), {
      uncertain: response.getResponseCode() >= 500,
    });
  }
  return data;
}

function textValue_(value) {
  return Array.isArray(value)
    ? value.join('; ')
    : String(value == null ? '' : value).trim();
}

function literal_(value) {
  return typeof value === 'string' && /^[=+@-]/.test(value)
    ? "'" + value
    : value;
}

function thaiSimFields_(kind) {
  return kind === 'patients' ? PF : AF;
}

function thaiSimHeaders_(kind) {
  return kind === 'patients' ? PH : AH;
}

function parseRow_(kind, cells, index) {
  var patient = kind === 'patients';
  var fieldStart = patient ? 4 : 3;
  var metadata = patient ? 17 : 10;
  var row = {
    index,
    action: textValue_(cells[0]),
    status: textValue_(cells[1]),
    id: textValue_(cells[patient ? 2 : 9]),
    incidentId: patient ? textValue_(cells[3]) : '',
    key: textValue_(cells[metadata]),
    version: Number(cells[metadata + 1]),
    baseline: textValue_(cells[metadata + 2]),
    nonce: textValue_(cells[metadata + 3]),
    values: {},
  };
  thaiSimFields_(kind).forEach((field, position) => {
    row.values[field] = textValue_(cells[fieldStart + position]);
  });
  return row;
}

function thaiSimRows_(sheet, kind) {
  var headers = thaiSimHeaders_(kind);
  var cells = sheet
    .getRange(1, 1, Math.max(1, sheet.getLastRow()), headers.length)
    .getValues();
  if (headers.some((value, position) => value !== cells[0][position])) {
    throw new Error('หัวตารางชีต ' + SHEETS[kind] + ' เปลี่ยน');
  }
  return cells
    .slice(1)
    .flatMap((row, index) =>
      row.some((value) => value !== '')
        ? [parseRow_(kind, row, index + 2)]
        : [],
    );
}

function thaiSimChange_(kind, row) {
  var requested = row.action.toUpperCase();
  var action =
    { เพิ่ม: 'CREATE', แก้ไข: 'UPDATE', ลบ: 'DELETE' }[requested] || requested;
  if (
    !action &&
    row.key &&
    row.baseline &&
    JSON.stringify(row.values) !== row.baseline
  )
    action = 'UPDATE';
  if (!action) return null;
  if (!['CREATE', 'UPDATE', 'DELETE'].includes(action))
    throw new Error('เลือกคำสั่ง เพิ่ม แก้ไข หรือลบ');
  if (action === 'CREATE' && row.key) throw new Error('แถวนี้มีรายการอยู่แล้ว');
  if (
    action !== 'CREATE' &&
    (!row.key ||
      !row.id ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1)
  ) {
    throw new Error('ไม่พบคีย์หรือรุ่นข้อมูลของแถวนี้');
  }

  var values = { ...row.values };
  if (kind === 'patients') {
    if (!row.incidentId) throw new Error('กรอกรหัสเหตุการณ์จากแท็บเหตุการณ์');
    if (action !== 'CREATE' && row.key !== row.incidentId + ':' + row.id) {
      throw new Error('รหัสผู้ป่วยหรือเหตุการณ์ไม่ตรงกับคีย์ในแถว');
    }
    for (var field of Object.keys(DISPLAY)) {
      var option = Object.entries(DISPLAY[field]).find(
        (pair) => pair[1] === values[field],
      );
      if (option) values[field] = option[0];
    }
    values.interventions = values.interventions
      .split(';')
      .map(textValue_)
      .filter(Boolean);
    return {
      Action: action,
      entityId: row.key,
      id: row.id,
      incidentId: row.incidentId,
      version: row.version,
      ...values,
    };
  }
  if (action !== 'CREATE' && row.key !== row.id)
    throw new Error('รหัสบัญชีไม่ตรงกับคีย์ในแถว');
  return {
    Action: action,
    accountId: row.id,
    incidentId: 'legacy',
    version: row.version,
    ...values,
  };
}

function requestId_(kind, row, change) {
  var identity =
    change.Action === 'CREATE' ? [kind, row.nonce] : [kind, row.key, change];
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(identity),
  );
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function thaiSimRecordKey_(kind, record) {
  return (
    record.entityId ||
    (kind === 'patients' ? record.incidentId + ':' + record.id : record.id)
  );
}

function thaiSimRecordCells_(kind, record, status) {
  var values = Object.fromEntries(
    thaiSimFields_(kind).map((field) => [
      field,
      DISPLAY[field]?.[record[field]] || textValue_(record[field]),
    ]),
  );
  var identity =
    kind === 'patients' ? [record.id, record.incidentId] : [record.username];
  var shared = Object.values(values);
  if (kind === 'accounts') shared.push(record.id);
  return [
    '',
    status,
    ...identity,
    ...shared,
    thaiSimRecordKey_(kind, record),
    record.version,
    JSON.stringify(values),
    '',
  ].map(literal_);
}

function thaiSimWrite_(sheet, index, cells) {
  if (index > sheet.getMaxRows())
    sheet.insertRowsAfter(sheet.getMaxRows(), index - sheet.getMaxRows());
  sheet.getRange(index, 1, 1, cells.length).setValues([cells]);
}

function fingerprint_(row) {
  return JSON.stringify([
    row.action,
    row.id,
    row.incidentId,
    row.key,
    row.version,
    row.nonce,
    row.values,
  ]);
}

function thaiSimApplyRows_(config, sheet, kind) {
  var rows = thaiSimRows_(sheet, kind);
  var unresolvedCreate = false;
  var keys = new Map();
  rows.forEach((row) => {
    if (row.key) keys.set(row.key, (keys.get(row.key) || 0) + 1);
  });
  for (var row of rows) {
    try {
      var change = thaiSimChange_(kind, row);
      if (!change) continue;
      if (row.key && keys.get(row.key) > 1) throw new Error('มีรหัสรายการซ้ำในชีต');
      var width = thaiSimHeaders_(kind).length;
      if (change.Action === 'CREATE' && !row.nonce) {
        var current = parseRow_(
          kind,
          sheet.getRange(row.index, 1, 1, width).getValues()[0],
          row.index,
        );
        if (fingerprint_(current) !== fingerprint_(row)) continue;
        row.nonce = Utilities.getUuid();
        sheet.getRange(row.index, width).setValue(row.nonce);
        SpreadsheetApp.flush();
      }
      var body = {
        requestId: requestId_(kind, row, change),
        incidentId: change.incidentId,
        [kind]: [change],
      };
      var result = thaiSimRequest_(config, 'changes', body).applied[kind][0];
      var counterpart = thaiSimRows_(sheet, kind).find((candidate) =>
        row.key ? candidate.key === row.key : candidate.nonce === row.nonce,
      );
      if (!counterpart || fingerprint_(counterpart) !== fingerprint_(row)) {
        if (change.Action === 'CREATE' && counterpart) unresolvedCreate = true;
        continue;
      }
      if (result.action === 'DELETE') {
        sheet.getRange(counterpart.index, 1, 1, width).clearContent();
      } else {
        thaiSimWrite_(
          sheet,
          counterpart.index,
          thaiSimRecordCells_(kind, result.record, 'ซิงก์แล้ว'),
        );
      }
    } catch (error) {
      if (change?.Action === 'CREATE' && error.uncertain)
        unresolvedCreate = true;
      var latest = parseRow_(
        kind,
        sheet
          .getRange(row.index, 1, 1, thaiSimHeaders_(kind).length)
          .getValues()[0],
        row.index,
      );
      if (fingerprint_(latest) === fingerprint_(row)) {
        sheet.getRange(row.index, 2).setValue('ตรวจสอบ: ' + error.message);
      }
    }
  }
  return unresolvedCreate;
}

function thaiSimPull_(sheet, kind, records, pauseNewRows) {
  var canonical = new Map(
    records.map((record) => [thaiSimRecordKey_(kind, record), record]),
  );
  var missing = new Map(canonical);
  var rows = thaiSimRows_(sheet, kind);
  var keys = new Map();
  rows.forEach((row) => {
    if (row.key) keys.set(row.key, (keys.get(row.key) || 0) + 1);
  });
  for (var row of rows) {
    if (!row.key) continue;
    missing.delete(row.key);
    if (keys.get(row.key) > 1) continue;
    var width = thaiSimHeaders_(kind).length;
    var live = parseRow_(
      kind,
      sheet.getRange(row.index, 1, 1, width).getValues()[0],
      row.index,
    );
    if (fingerprint_(live) !== fingerprint_(row)) continue;
    try {
      if (thaiSimChange_(kind, row)) continue;
    } catch (_) {
      continue;
    }
    var record = canonical.get(row.key);
    if (!record) sheet.getRange(row.index, 1, 1, width).clearContent();
    else if (record.version !== row.version) {
      thaiSimWrite_(
        sheet,
        row.index,
        thaiSimRecordCells_(kind, record, 'อัปเดตจากเว็บ'),
      );
    }
  }
  if (!pauseNewRows) {
    for (var record of missing.values()) {
      thaiSimWrite_(
        sheet,
        sheet.getLastRow() + 1,
        thaiSimRecordCells_(kind, record, 'ซิงก์แล้ว'),
      );
    }
  }
}

function syncThaiSimNow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var config = thaiSimConfig_();
    var workbook = SpreadsheetApp.openById(config.id);
    var patients = workbook.getSheetByName(SHEETS.patients);
    var accounts = workbook.getSheetByName(SHEETS.accounts);
    var incidents = workbook.getSheetByName(SHEETS.incidents);
    if (!patients || !accounts || !incidents)
      throw new Error('ไม่พบแท็บผู้ป่วย เจ้าหน้าที่ หรือเหตุการณ์');
    var headings = incidents.getRange(1, 1, 1, IH.length).getValues()[0];
    if (IH.some((value, position) => headings[position] !== value)) {
      throw new Error('หัวตารางชีตเหตุการณ์เปลี่ยน');
    }

    var pendingPatients = thaiSimApplyRows_(config, patients, 'patients');
    var pendingAccounts = thaiSimApplyRows_(config, accounts, 'accounts');
    var snapshot = thaiSimRequest_(config, 'snapshot');
    thaiSimPull_(patients, 'patients', snapshot.patients, pendingPatients);
    thaiSimPull_(accounts, 'accounts', snapshot.accounts, pendingAccounts);
    var counts = new Map();
    snapshot.patients.forEach((patient) => {
      counts.set(patient.incidentId, (counts.get(patient.incidentId) || 0) + 1);
    });
    var rows = snapshot.incidents.map((incident) => [
      incident.id,
      literal_(incident.name),
      incident.openedAt,
      incident.closedAt || '',
      counts.get(incident.id) || 0,
    ]);
    if (rows.length > incidents.getMaxRows() - 1) {
      incidents.insertRowsAfter(
        incidents.getMaxRows(),
        rows.length - incidents.getMaxRows() + 1,
      );
    }
    if (rows.length)
      incidents.getRange(2, 1, rows.length, IH.length).setValues(rows);
    var unused = incidents.getLastRow() - 1 - rows.length;
    if (unused > 0)
      incidents.getRange(rows.length + 2, 1, unused, IH.length).clearContent();
    SpreadsheetApp.flush();
    thaiSimRequest_(config, 'heartbeat', { sheetId: config.id });
  } finally {
    lock.releaseLock();
  }
}
