/**
 * VipMobile -> Google Sheet sync endpoint.
 *
 * Tabs: iPhone / Samsung / Boshqa (one per brand) + Telefonlar (every
 * currently "Band" phone, across all brands, in one place).
 *
 * Each brand tab is grouped by exact model ("17 Pro Max", "S24 Ultra", ...),
 * newest-first, with a blank row between groups. Within a tab, rows are in
 * three sections top-to-bottom: not-sold, then Band, then Sotilgan at the
 * very bottom (this matches the app's own ordering - tell me if you'd
 * rather have Sotilgan at the top instead, it's a one-line change).
 *
 * Columns A (ID) and B (Status) are internal bookkeeping and stay hidden -
 * everything from column C on is the real visible data, starting with
 * "Kimdan olindi".
 *
 * SETUP / REDEPLOY: same as before - paste this whole file in, run
 * setupSheet once, then Deploy -> Manage deployments -> edit -> New
 * version -> Deploy (keeps the same URL).
 */

var SHEET_DEFS = [
  { key: 'iphone',  name: 'iPhone',  color: '#2A3B8F' },
  { key: 'samsung', name: 'Samsung', color: '#96682B' },
  { key: 'other',   name: 'Boshqa',  color: '#3F4A5A' }
];
var BAND_SHEET_NAME = 'Telefonlar';
var BAND_SHEET_COLOR = '#4C6B5A';

// Column C onward - what the user actually sees. A (ID) and B (Status) are hidden bookkeeping.
var HEADERS = [
  'ID', 'Status',
  "Kimdan olindi", 'Uning raqami', 'Telefon nomi', 'Karobka', 'IMEI',
  "Sotib olingan sana", "Sotib olingan vaqti", 'Sotilgan sana', 'Sotilgan vaqti',
  "Sotib olingan narx", 'Sotilgan narx',
  'Kimga sotildi', 'Xaridor raqami'
];
var DATE_FORMAT = 'dd/mm/yy';

/* ====================== iPhone party/generation grouping (ported from the app) ====================== */
var IPHONE_PARTY_PATTERNS = (function () {
  var pats = [];
  ['18', '17', '16', '15', '14', '13', '12', '11'].forEach(function (g) {
    pats.push([new RegExp(g + '\\s*PRO\\s*MAX'), g + ' Pro Max']);
    pats.push([new RegExp(g + '\\s*MAX\\b'), g + ' Pro Max']);
    pats.push([new RegExp(g + '\\s*PRO\\b'), g + ' Pro']);
    pats.push([new RegExp(g + '\\s*PLUS\\b'), g + ' Plus']);
    pats.push([new RegExp(g + '\\s*MINI\\b'), g + ' Mini']);
    pats.push([new RegExp(g + '\\s*AIR\\b'), g + ' Air']);
    pats.push([new RegExp('\\b' + g + '\\b'), g]);
  });
  pats.push([/XS\s*MAX/, 'XS Max']);
  pats.push([/\bXS\b/, 'XS']);
  pats.push([/\bXR\b/, 'XR']);
  pats.push([/\bX\b/, 'X']);
  pats.push([/\bSE\b/, 'SE']);
  return pats;
})();
function iphoneParty_(model) {
  var m = (model || '').toUpperCase();
  for (var i = 0; i < IPHONE_PARTY_PATTERNS.length; i++) {
    if (IPHONE_PARTY_PATTERNS[i][0].test(m)) return IPHONE_PARTY_PATTERNS[i][1];
  }
  return 'Boshqa';
}
var IPHONE_GENERATIONS = ['18', '17', '16', '15', '14', '13', '12', '11', 'X', 'SE'];
var PARTY_SUFFIX_ORDER = ['Pro Max', 'Pro', 'Plus', '', 'Mini', 'Air'];
function iphoneGeneration_(party) {
  if (party === 'Boshqa') return 'Boshqa';
  var m = party.match(/^(\d+)/);
  if (m) return m[1];
  if (/^X/.test(party)) return 'X';
  if (/^SE/.test(party)) return 'SE';
  return 'Boshqa';
}
function iphonePartySortKey_(party) {
  var gen = iphoneGeneration_(party);
  var genIdx = IPHONE_GENERATIONS.indexOf(gen);
  if (genIdx < 0) genIdx = 999;
  var suffix = party.replace(/^\d+\s*/, '').replace(/^(X[RS]?|SE)\s*/, '');
  var subIdx = PARTY_SUFFIX_ORDER.indexOf(suffix);
  if (subIdx < 0) subIdx = 50;
  return genIdx * 100 + subIdx;
}

/* ====================== Samsung party/generation grouping (ported from the app) ====================== */
function samsungGenAndParty_(model) {
  var m = (model || '').toUpperCase();
  var mm = m.match(/\b(S|A|M)\s?(\d{1,2})/);
  if (mm) {
    var gen = mm[1] + mm[2];
    var suffix = '';
    if (/ULTRA/.test(m)) suffix = ' Ultra';
    else if (/\+|PLUS/.test(m)) suffix = ' Plus';
    else if (/\bFE\b/.test(m)) suffix = ' FE';
    return { gen: gen, party: gen + suffix };
  }
  var nm = m.match(/NOTE\s?(\d{1,3})?/);
  if (nm) {
    var gen2 = 'Note' + (nm[1] || '');
    return { gen: gen2, party: gen2 };
  }
  var zm = m.match(/Z\s?(FOLD|FLIP)\s?(\d*)/);
  if (zm) {
    var gen3 = 'Z ' + zm[1].charAt(0) + zm[1].slice(1).toLowerCase();
    return { gen: gen3, party: gen3 + (zm[2] ? ' ' + zm[2] : '') };
  }
  if (/\bTAB/.test(m)) return { gen: 'Tab', party: 'Tab' };
  return { gen: 'Boshqa', party: 'Boshqa' };
}
function samsungGenSortKey_(gen) {
  var m = gen.match(/^([SAM])(\d+)$/);
  if (m) {
    var prefixOrder = { S: 0, A: 2, M: 3 }[m[1]];
    return prefixOrder * 1000 - parseInt(m[2], 10);
  }
  if (/^Note/.test(gen)) return 500 - (parseInt(gen.replace(/\D/g, ''), 10) || 0);
  if (/^Z Fold/.test(gen)) return 700;
  if (/^Z Flip/.test(gen)) return 750;
  if (gen === 'Tab') return 800;
  return 9999;
}
var SAMSUNG_SUFFIX_ORDER = ['Ultra', 'Plus', '', 'FE'];
function samsungPartySortKey_(party, gen) {
  var suffix = party.slice(gen.length);
  var idx = SAMSUNG_SUFFIX_ORDER.indexOf(suffix);
  return idx < 0 ? 50 : idx;
}

/* ====================== sheet plumbing ====================== */
/** Only formats a BRAND NEW sheet. An existing sheet is left alone - re-applying
 *  header/column/tab formatting on every single sync was the main reason syncs
 *  felt slow (each sync touches 4 sheets x ~6 formatting calls = ~24 extra API
 *  calls that have nothing to do with the actual data). Run setupSheet() by hand
 *  any time you want formatting refreshed on existing sheets. */
function getOrCreateSheet_(name, color) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    try { formatSheet_(sh, color); } catch (e) { Logger.log('format ' + name + ' failed: ' + e); }
  }
  return sh;
}

/** Re-applies header row + column formatting WITHOUT touching data rows below. Safe to call anytime. */
function formatSheet_(sh, color) {
  function safely_(fn, label) {
    try { fn(); } catch (e) { Logger.log('formatSheet_ step failed (' + label + '): ' + e); }
  }

  var headerRange = sh.getRange(1, 1, 1, HEADERS.length);
  headerRange.setValues([HEADERS]); // must succeed - this IS the header row

  safely_(function () {
    headerRange.setFontWeight('bold').setBackground(color).setFontColor('#ffffff')
      .setHorizontalAlignment('center').setVerticalAlignment('middle').setFontSize(10);
  }, 'header style');
  safely_(function () { sh.setRowHeight(1, 32); }, 'row height');
  safely_(function () { sh.setFrozenRows(1); }, 'freeze header');

  safely_(function () {
    var widths = [40, 60, 150, 110, 260, 70, 170, 100, 70, 100, 70, 100, 100, 170, 120];
    for (var i = 0; i < widths.length; i++) sh.setColumnWidth(i + 1, widths[i]);
  }, 'column widths');
  safely_(function () { sh.hideColumns(1, 2); }, 'hide id/status columns');

  safely_(function () {
    var dataRows = Math.max(1, sh.getMaxRows() - 1);
    sh.getRange(2, 8, dataRows, 1).setNumberFormat(DATE_FORMAT);  // bought date
    sh.getRange(2, 10, dataRows, 1).setNumberFormat(DATE_FORMAT); // sold date
    sh.getRange(2, 12, dataRows, 2).setNumberFormat('"$"#,##0');  // bought/sold rate
  }, 'number formats');

  safely_(function () { sh.setTabColor(color); }, 'tab color');
}

function rowFor_(rec) {
  return [
    rec.id, rec.status || 'stock',
    rec.source || '', rec.sourcePhone || '', rec.model || '',
    rec.imeiBox ? 'Bor' : "Yo'q", rec.imei || '',
    rec.buyDate || '', rec.buyTime || '', rec.sellDate || '', rec.sellTime || '',
    rec.buyPrice != null ? rec.buyPrice : '', rec.sellPrice != null ? rec.sellPrice : '',
    rec.buyer || '', rec.buyerPhone || ''
  ];
}
function blankRow_() { return HEADERS.map(function () { return ''; }); }
function dividerRow_(label) { var r = blankRow_(); r[2] = label; return r; }

function dateBack_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v || '';
}
function byBuyDateDesc_(a, b) {
  if (!a.buyDate && !b.buyDate) return 0;
  if (!a.buyDate) return 1;
  if (!b.buyDate) return -1;
  if (a.buyDate !== b.buyDate) return a.buyDate < b.buyDate ? 1 : -1;
  return 0;
}

/** Reads back every real data row (skips blank/divider rows) as record objects. */
function readSheetRecords_(sh) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var values = sh.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  var out = [];
  values.forEach(function (row) {
    var id = row[0];
    if (!id) return;
    out.push({
      id: id, status: row[1] || 'stock',
      source: row[2] || '', sourcePhone: row[3] || '', model: row[4] || '',
      imeiBox: row[5] === 'Bor', imei: row[6] || '',
      buyDate: dateBack_(row[7]), buyTime: row[8] || '',
      sellDate: dateBack_(row[9]), sellTime: row[10] || '',
      buyPrice: row[11] === '' ? null : row[11], sellPrice: row[12] === '' ? null : row[12],
      buyer: row[13] || '', buyerPhone: row[14] || ''
    });
  });
  return out;
}

/** Builds the grouped/tiered/spaced row list for one brand's sheet. partyFns is null for Boshqa (no grouping). */
function buildGroupedRows_(items, partyFns) {
  var out = [];
  function emit(list) {
    if (!partyFns) {
      list.slice().sort(byBuyDateDesc_).forEach(function (it) { out.push(rowFor_(it)); });
      return;
    }
    var groups = {};
    list.forEach(function (it) {
      var party = partyFns.party(it.model);
      (groups[party] = groups[party] || []).push(it);
    });
    var names = Object.keys(groups).sort(function (a, b) { return partyFns.sortKey(a) - partyFns.sortKey(b); });
    names.forEach(function (party, idx) {
      if (idx > 0) out.push(blankRow_());
      var rows = groups[party].slice().sort(byBuyDateDesc_);
      rows.forEach(function (it) { out.push(rowFor_(it)); });
    });
  }

  var notSold = items.filter(function (it) { return it.status !== 'sold' && it.status !== 'lent'; });
  var band = items.filter(function (it) { return it.status === 'lent'; });
  var sold = items.filter(function (it) { return it.status === 'sold'; });

  emit(notSold);
  if (band.length) { out.push(dividerRow_('BAND (' + band.length + ' ta)')); emit(band); }
  if (sold.length) { out.push(dividerRow_('SOTILGAN (' + sold.length + ' ta)')); emit(sold); }
  return out;
}

function writeBody_(sh, rows) {
  var lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, HEADERS.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
}

var PARTY_FNS = {
  iphone: { party: iphoneParty_, sortKey: iphonePartySortKey_ },
  samsung: { party: function (m) { return samsungGenAndParty_(m).party; }, sortKey: function (party) {
    var gen = samsungGenAndParty_(party).gen;
    return samsungGenSortKey_(gen) * 10 + samsungPartySortKey_(party, gen);
  } }
};

/** Re-reads every brand sheet + the given change, then rewrites all 4 tabs. This is the single
 *  source of truth for ordering/grouping, so every write (single or bulk) goes through it. */
function applyChangeAndRewriteAll_(mutate) {
  var sheets = {};
  var master = {}; // id -> record
  SHEET_DEFS.forEach(function (def) {
    var sh = getOrCreateSheet_(def.name, def.color);
    sheets[def.key] = sh;
    readSheetRecords_(sh).forEach(function (rec) { rec.brand = def.key; master[rec.id] = rec; });
  });

  mutate(master); // caller adds/updates/removes records in place

  var buckets = { iphone: [], samsung: [], other: [] };
  var bandAll = [];
  Object.keys(master).forEach(function (id) {
    var rec = master[id];
    if (!rec) return;
    var brand = buckets[rec.brand] ? rec.brand : 'other';
    buckets[brand].push(rec);
    if (rec.status === 'lent') bandAll.push(rec);
  });

  SHEET_DEFS.forEach(function (def) {
    var rows = buildGroupedRows_(buckets[def.key], PARTY_FNS[def.key] || null);
    writeBody_(sheets[def.key], rows);
  });

  var bandSheet = getOrCreateSheet_(BAND_SHEET_NAME, BAND_SHEET_COLOR);
  var bandRows = buildGroupedRows_(bandAll, null);
  writeBody_(bandSheet, bandRows);
}

/** Run this once from the editor (and again any time you want formatting refreshed -
 *  e.g. after changing SHEET_DEFS colors, or to fix a column width you changed by hand).
 *  Never touches data rows. */
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  SHEET_DEFS.forEach(function (def) {
    var sh = getOrCreateSheet_(def.name, def.color);
    try { formatSheet_(sh, def.color); } catch (e) { Logger.log('format ' + def.name + ' failed: ' + e); }
  });
  var bandSh = getOrCreateSheet_(BAND_SHEET_NAME, BAND_SHEET_COLOR);
  try { formatSheet_(bandSh, BAND_SHEET_COLOR); } catch (e) { Logger.log('format band failed: ' + e); }
  ss.getSheets().forEach(function (s) {
    var keep = SHEET_DEFS.some(function (d) { return d.name === s.getName(); }) || s.getName() === BAND_SHEET_NAME;
    if (!keep && s.getLastRow() === 0) {
      try { ss.deleteSheet(s); } catch (e) { /* can't delete the only sheet left; ignore */ }
    }
  });
  SpreadsheetApp.flush();
}

/* ====================== HTTP entry points ====================== */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;

    if (action === 'upsert') {
      applyChangeAndRewriteAll_(function (master) {
        var d = body.data || {};
        master[body.id] = {
          id: body.id, brand: d.brand || 'other', status: d.status || 'stock',
          source: d.source || '', sourcePhone: d.sourcePhone || '', model: d.model || '',
          imeiBox: !!d.imeiBox, imei: d.imei || '',
          buyDate: d.buyDate || '', buyTime: d.buyTime || '', sellDate: d.sellDate || '', sellTime: d.sellTime || '',
          buyPrice: d.buyPrice != null ? d.buyPrice : null, sellPrice: d.sellPrice != null ? d.sellPrice : null,
          buyer: d.buyer || '', buyerPhone: d.buyerPhone || ''
        };
      });
      return ContentService.createTextOutput(JSON.stringify({ ok: true }));
    }

    if (action === 'delete') {
      applyChangeAndRewriteAll_(function (master) { delete master[body.id]; });
      return ContentService.createTextOutput(JSON.stringify({ ok: true }));
    }

    if (action === 'bulkUpsert') {
      applyChangeAndRewriteAll_(function (master) {
        Object.keys(master).forEach(function (id) { delete master[id]; }); // bulk payload is authoritative
        (body.rows || []).forEach(function (r) {
          var d = r.data || {};
          master[r.id] = {
            id: r.id, brand: d.brand || 'other', status: d.status || 'stock',
            source: d.source || '', sourcePhone: d.sourcePhone || '', model: d.model || '',
            imeiBox: !!d.imeiBox, imei: d.imei || '',
            buyDate: d.buyDate || '', buyTime: d.buyTime || '', sellDate: d.sellDate || '', sellTime: d.sellTime || '',
            buyPrice: d.buyPrice != null ? d.buyPrice : null, sellPrice: d.sellPrice != null ? d.sellPrice : null,
            buyer: d.buyer || '', buyerPhone: d.buyerPhone || ''
          };
        });
      });
      return ContentService.createTextOutput(JSON.stringify({ ok: true, count: (body.rows || []).length }));
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unknown action' }));
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err), stack: err.stack || '' }));
  }
}

/** Returns every tracked record (id-having rows, tagged with brand) plus any
 *  "unidentified" rows - real data rows that were typed straight into the Sheet
 *  by hand and so have no ID yet in the hidden column A. The app uses this to:
 *   (a) pull a frozen archived month's totals (Moliya > Oylar), and
 *   (b) two-way sync: find rows added directly in the Sheet, create a matching
 *       Firestore record for each, and let the next normal sync fold them in
 *       (which also wipes the old ID-less row so there's no duplicate). */
function exportAllData_() {
  var records = [];
  var unidentified = [];
  SHEET_DEFS.forEach(function (def) {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(def.name);
    if (!sh) return;
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return;
    var values = sh.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    values.forEach(function (row, idx) {
      var id = row[0];
      var model = row[4];
      if (!id && !model) return; // blank/divider row
      var rec = {
        id: id || null, status: row[1] || 'stock', brand: def.key,
        source: row[2] || '', sourcePhone: row[3] || '', model: model || '',
        imeiBox: row[5] === 'Bor', imei: row[6] || '',
        buyDate: dateBack_(row[7]), buyTime: row[8] || '',
        sellDate: dateBack_(row[9]), sellTime: row[10] || '',
        buyPrice: row[11] === '' ? null : row[11], sellPrice: row[12] === '' ? null : row[12],
        buyer: row[13] || '', buyerPhone: row[14] || ''
      };
      if (id) { records.push(rec); }
      else { rec.sheetName = def.name; rec.sheetRow = idx + 2; unidentified.push(rec); }
    });
  });
  var out = { ok: true, records: records, unidentified: unidentified, exportedAt: new Date().toISOString() };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'export') return exportAllData_();
  return ContentService.createTextOutput('VipMobile sync endpoint is running.');
}
