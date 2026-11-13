/**
 * VipMobile -> Google Sheet sync endpoint.
 *
 * Tabs, left to right:  Barcha | iPhone | Samsung | Yangi | Boshqa
 *   Barcha  - every phone (grouped iPhone, then Samsung, then Boshqa)
 *   iPhone / Samsung / Boshqa - one per brand, USED PHONES ONLY
 *   Yangi   - every phone marked NEW (any brand) - new phones are NOT repeated in the brand tabs
 * So a phone is in exactly one of iPhone / Samsung / Yangi / Boshqa, and additionally in Barcha.
 *
 * Inside a tab, phones are grouped by exact model ("17 Pro Max", "S24 Ultra", ...),
 * newest-first, with a blank row between groups. Rows are in three sections
 * top-to-bottom: not-sold, then Band, then Sotilgan at the very bottom
 * (this matches the app's own ordering).
 *
 * Columns A (ID), B (Status), P (Yangi flag) and Q (Brand) are internal bookkeeping and stay hidden -
 * everything from column C to O is the real visible data, starting with "Kimdan olindi".
 *
 * You can type a new phone into ANY tab (no ID needed): the platform picks it up within a minute.
 *
 * SETUP / REDEPLOY: paste this whole file in, then Deploy -> Manage deployments -> edit ->
 * New version -> Deploy (keeps the same URL). Tabs are created/renamed automatically
 * (an old "Band"/"Telefonlar" tab becomes "Barcha").
 */

// Source-of-truth tabs: every record is stored in exactly one of these (its brand).
var SHEET_DEFS = [
  { key: 'iphone',  name: 'iPhone',  color: '#2A3B8F' },
  { key: 'samsung', name: 'Samsung', color: '#96682B' },
  { key: 'other',   name: 'Boshqa',  color: '#3F4A5A' }
];
// Derived tabs: rewritten from the records above on every sync.
var ALL_TAB = { key: 'all', name: 'Barcha', color: '#2F6B4F' };
var NEW_TAB = { key: 'new', name: 'Yangi',  color: '#7A3E8E' };
var OLD_ALL_TAB_NAMES = ['Band', 'Telefonlar']; // earlier name of the combined tab; renamed in place so nothing is lost
var TAB_ORDER = ['Barcha', 'iPhone', 'Samsung', 'Yangi', 'Boshqa'];
function allTabs_() { return [ALL_TAB, SHEET_DEFS[0], SHEET_DEFS[1], NEW_TAB, SHEET_DEFS[2]]; }
var tabsCreated_ = false;

// Column C onward - what the user actually sees. A (ID) and B (Status) are hidden bookkeeping.
var HEADERS = [
  'ID', 'Status',
  "Kimdan olindi", 'Uning raqami', 'Telefon nomi', 'Karobka', 'IMEI',
  "Sotib olingan sana", "Sotib olingan vaqti", 'Sotilgan sana', 'Sotilgan vaqti',
  "Sotib olingan narx", 'Sotilgan narx',
  'Kimga sotildi', 'Xaridor raqami', 'Yangi', 'Brand'
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
  if (/\bTAB/.test(m)) return { gen: 'Tab', party: 'Tab' };
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
  var suffix = party.slice(gen.length).trim();      // " Ultra" -> "Ultra" (the leading space used to break the lookup)
  var idx = SAMSUNG_SUFFIX_ORDER.indexOf(suffix);
  return idx < 0 ? 9 : idx;
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
  if (!sh && name === ALL_TAB.name) {
    for (var i = 0; i < OLD_ALL_TAB_NAMES.length; i++) {
      var old = ss.getSheetByName(OLD_ALL_TAB_NAMES[i]);
      if (old) {
        old.setName(name);
        try { formatSheet_(old, color); } catch (e) { Logger.log('format ' + name + ' failed: ' + e); }
        tabsCreated_ = true;
        return old;
      }
    }
  }
  if (!sh) {
    sh = ss.insertSheet(name);
    tabsCreated_ = true;
    try { formatSheet_(sh, color); } catch (e) { Logger.log('format ' + name + ' failed: ' + e); }
  }
  return sh;
}
/** Older sheets only have 15 columns / no "Yangi" header: bring them up to date once. */
function ensureHeader_(sh, color) {
  var ok = false;
  try { ok = sh.getMaxColumns() >= HEADERS.length && sh.getRange(1, HEADERS.length).getValue() === 'Brand'; } catch (e) { ok = false; }
  if (!ok) { try { formatSheet_(sh, color); } catch (e) { Logger.log('ensureHeader ' + e); } }
}
function orderTabs_() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    TAB_ORDER.forEach(function (n, i) {
      var sh = ss.getSheetByName(n);
      if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
    });
    var first = ss.getSheetByName(TAB_ORDER[0]);
    if (first) ss.setActiveSheet(first);
  } catch (e) { Logger.log('orderTabs_ failed: ' + e); }
}

/** Re-applies header row + column formatting WITHOUT touching data rows below. Safe to call anytime. */
function formatSheet_(sh, color) {
  function safely_(fn, label) {
    try { fn(); } catch (e) { Logger.log('formatSheet_ step failed (' + label + '): ' + e); }
  }

  safely_(function () {
    if (sh.getMaxColumns() < HEADERS.length) sh.insertColumnsAfter(sh.getMaxColumns(), HEADERS.length - sh.getMaxColumns());
  }, 'add columns');
  var headerRange = sh.getRange(1, 1, 1, HEADERS.length);
  headerRange.setValues([HEADERS]); // must succeed - this IS the header row

  safely_(function () {
    headerRange.setFontWeight('bold').setBackground(color).setFontColor('#ffffff')
      .setHorizontalAlignment('center').setVerticalAlignment('middle').setFontSize(10);
  }, 'header style');
  safely_(function () { sh.setRowHeight(1, 32); }, 'row height');
  safely_(function () { sh.setFrozenRows(1); }, 'freeze header');

  safely_(function () {
    var widths = [40, 60, 150, 110, 260, 70, 170, 100, 70, 100, 70, 100, 100, 170, 120, 50, 60];
    for (var i = 0; i < widths.length; i++) sh.setColumnWidth(i + 1, widths[i]);
  }, 'column widths');
  safely_(function () { sh.hideColumns(1, 2); }, 'hide id/status columns');
  safely_(function () { sh.hideColumns(HEADERS.length - 1, 2); }, 'hide Yangi flag + Brand columns');

  safely_(function () {
    var dataRows = Math.max(1, sh.getMaxRows() - 1);
    sh.getRange(2, 8, dataRows, 1).setNumberFormat(DATE_FORMAT);  // bought date
    sh.getRange(2, 10, dataRows, 1).setNumberFormat(DATE_FORMAT); // sold date
    sh.getRange(2, 12, dataRows, 2).setNumberFormat('"$"#,##0');  // bought/sold rate
    sh.getRange(2, 4, dataRows, 1).setNumberFormat('@');          // phone number (text: keeps +998 / leading zeros)
    sh.getRange(2, 7, dataRows, 1).setNumberFormat('@');          // IMEI (text: never 3.5E+14)
    sh.getRange(2, 15, dataRows, 1).setNumberFormat('@');         // buyer phone
    sh.getRange(2, 9, dataRows, 1).setNumberFormat('@');          // bought time  (plain text, so "14:35" stays "14:35")
    sh.getRange(2, 11, dataRows, 1).setNumberFormat('@');         // sold time
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
    rec.buyer || '', rec.buyerPhone || '',
    rec.isNew ? 'Yangi' : 'Ishlatilgan',
    rec.brand || ''
  ];
}
function blankRow_() { return HEADERS.map(function () { return ''; }); }
function dividerRow_(label) { var r = blankRow_(); r[2] = label; return r; }

function sheetTz_() {
  try { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(); } catch (e) { return Session.getScriptTimeZone(); }
}
function dateBack_(v) {
  // same time zone as timeBack_ (the spreadsheet's), otherwise dates can shift a day when the script zone differs
  if (v instanceof Date) return Utilities.formatDate(v, sheetTz_(), 'yyyy-MM-dd');
  return v || '';
}
function timeBack_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'HH:mm');
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
/** Reads every data row as arrays exactly HEADERS.length wide (older sheets may have fewer columns). */
function readRows_(sh) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var width = HEADERS.length;
  try { width = Math.min(HEADERS.length, sh.getMaxColumns()); } catch (e) {}
  var values = sh.getRange(2, 1, lastRow - 1, width).getValues();
  return values.map(function (row) { var r = row.slice(); while (r.length < HEADERS.length) r.push(''); return r; });
}
function isNewModel_(model) { return /NEW/i.test(model || '') && !/RENEW/i.test(model || ''); }
function sv_(v) { return v == null ? '' : String(v); }   // keep IMEI / phone cells as text even if Sheets turned them into numbers
function readSheetRecords_(sh) {
  var out = [];
  readRows_(sh).forEach(function (row) {
    var id = row[0];
    if (!id) return;
    out.push({
      id: id, status: row[1] || 'stock',
      source: sv_(row[2]), sourcePhone: sv_(row[3]), model: sv_(row[4]),
      imeiBox: row[5] === 'Bor', imei: sv_(row[6]),
      buyDate: dateBack_(row[7]), buyTime: timeBack_(row[8]),
      sellDate: dateBack_(row[9]), sellTime: timeBack_(row[10]),
      buyPrice: row[11] === '' ? null : row[11], sellPrice: row[12] === '' ? null : row[12],
      buyer: sv_(row[13]), buyerPhone: sv_(row[14]),
      isNew: row[15] === 'Yangi' ? true : (row[15] === 'Ishlatilgan' ? false : isNewModel_(row[4])),
      brandCell: row[16] || ''
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
      var party = partyFns.party(it);
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

/** Rows someone typed straight into a tab (no ID yet). The platform adopts them on its next check;
 *  until then every rewrite MUST keep them, otherwise a normal platform sync would silently erase them. */
var DIVIDER_RE = /^(BAND|SOTILGAN) \(\d+ ta\)$/;
function readPendingRows_(sh) {
  var out = [];
  readRows_(sh).forEach(function (row) {
    if (row[0]) return;                               // has an ID: normal record
    var hasData = false;
    for (var i = 2; i <= 14; i++) { if (row[i] !== '' && row[i] != null) { hasData = true; break; } }
    if (!hasData) return;                             // blank row
    if (!row[4] && !row[6] && DIVIDER_RE.test(String(row[2]).trim())) return;   // our own BAND / SOTILGAN divider
    out.push(row);                                    // anything else typed in (even half a row) is kept
  });
  return out;
}
function norm_(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, ' '); }
/** Same reading of a price as the platform (parseFlexNum): "$1,200" / "1 200" / "1,5" / 1200. */
function priceNorm_(v) {
  if (v === '' || v == null) return '';
  if (typeof v === 'number') return v;
  var s = String(v).replace(/\$/g, '').replace(/\s+/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, ''); else s = s.replace(/,/g, '.');
  if (s === '') return '';
  var n = Number(s);
  return isNaN(n) ? '' : n;
}
function softKey_(model, imei, buyPrice, source) {
  return [norm_(model), String(imei || '').replace(/\D/g, ''), priceNorm_(buyPrice), norm_(source)].join('|');
}
function pendingKey_(row) { return softKey_(row[4], row[6], row[11], row[2]); }
function recKey_(rec) { return softKey_(rec.model, rec.imei, rec.buyPrice, rec.source); }
function recFrom_(id, d) {
  d = d || {};
  return {
    id: id, brand: d.brand || 'other', status: d.status || 'stock',
    source: d.source || '', sourcePhone: d.sourcePhone || '', model: d.model || '',
    imeiBox: !!d.imeiBox, imei: d.imei || '',
    buyDate: d.buyDate || '', buyTime: d.buyTime || '', sellDate: d.sellDate || '', sellTime: d.sellTime || '',
    buyPrice: d.buyPrice != null ? d.buyPrice : null, sellPrice: d.sellPrice != null ? d.sellPrice : null,
    buyer: d.buyer || '', buyerPhone: d.buyerPhone || '',
    isNew: (d.isNew === undefined || d.isNew === null) ? isNewModel_(d.model) : !!d.isNew
  };
}

function writeBody_(sh, rows) {
  try {
    var need = rows.length + 1;
    if (typeof sh.getMaxRows === 'function' && typeof sh.insertRowsAfter === 'function' && need > sh.getMaxRows()) {
      sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows() + 100);   // a new sheet only has 1000 rows
    }
  } catch (e) { Logger.log('grow sheet failed: ' + e); }
  var lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, HEADERS.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
}

var PARTY_FNS = {
  iphone: { party: function (it) { return iphoneParty_(it.model); }, sortKey: iphonePartySortKey_ },
  samsung: { party: function (it) { return samsungGenAndParty_(it.model).party; }, sortKey: function (party) {
    var gen = samsungGenAndParty_(party).gen;
    return samsungGenSortKey_(gen) * 10 + samsungPartySortKey_(party, gen);
  } }
};
/** Barcha / Yangi hold several brands: iPhone models first (newest first), then Samsung, then the rest. */
var MIXED_FNS = {
  party: function (it) {
    var b = it.brand === 'iphone' || it.brand === 'samsung' ? it.brand : 'other';
    var p = b === 'iphone' ? iphoneParty_(it.model) : (b === 'samsung' ? samsungGenAndParty_(it.model).party : 'Boshqa');
    return b + '|' + p;
  },
  sortKey: function (key) {
    var i = key.indexOf('|'), b = key.slice(0, i), p = key.slice(i + 1), k = 0;
    if (b === 'iphone') k = iphonePartySortKey_(p);
    else if (b === 'samsung') { var g = samsungGenAndParty_(p).gen; k = samsungGenSortKey_(g) * 10 + samsungPartySortKey_(p, g); }
    return { iphone: 0, samsung: 1, other: 2 }[b] * 1000000 + 100000 + k;
  }
};

/** Re-reads every brand sheet + the given change, then rewrites all 4 tabs. This is the single
 *  source of truth for ordering/grouping, so every write (single or bulk) goes through it. */
function applyChangeAndRewriteAll_(mutate) {
  var tabs = allTabs_();
  var sheets = {};    // tab name -> sheet
  var pending = {};   // tab name -> rows typed directly into the sheet that the platform has not adopted yet
  var master = {};    // id -> record (read from the three brand tabs only; the others are derived views)
  tabs.forEach(function (def) {
    var sh = getOrCreateSheet_(def.name, def.color);
    ensureHeader_(sh, def.color);
    sheets[def.name] = sh;
    pending[def.name] = readPendingRows_(sh);
  });
  SHEET_DEFS.concat([NEW_TAB]).forEach(function (def) {      // new phones live in Yangi, used ones in their brand tab
    readSheetRecords_(sheets[def.name]).forEach(function (rec) {
      if (master[rec.id]) return;
      rec.brand = def.key === 'new' ? (rec.brandCell === 'iphone' || rec.brandCell === 'samsung' ? rec.brandCell : 'other') : def.key;
      delete rec.brandCell;
      master[rec.id] = rec;
    });
  });

  var adopted = mutate(master) || []; // caller adds/updates/removes records in place; may return records it adopted from the sheet

  // an adopted record replaces exactly one matching typed-in row (so it is not shown twice)
  adopted.forEach(function (rec) {
    var k = recKey_(rec);
    for (var i = 0; i < tabs.length; i++) {
      var list = pending[tabs[i].name];
      for (var j = 0; j < list.length; j++) {
        if (pendingKey_(list[j]) === k) { list.splice(j, 1); return; }
      }
    }
  });

  var buckets = { iphone: [], samsung: [], other: [] };
  var everything = [], fresh = [];
  Object.keys(master).forEach(function (id) {
    var rec = master[id];
    if (!rec) return;
    var brand = buckets[rec.brand] ? rec.brand : 'other';
    rec.brand = brand;
    everything.push(rec);
    if (rec.isNew) fresh.push(rec); else buckets[brand].push(rec);
  });

  function write(def, items, fns) {
    var rows = buildGroupedRows_(items, fns);
    pending[def.name].forEach(function (r) { rows.push(r); });   // typed-in rows stay at the bottom until adopted
    writeBody_(sheets[def.name], rows);
  }
  SHEET_DEFS.forEach(function (def) { write(def, buckets[def.key], PARTY_FNS[def.key] || null); });
  write(ALL_TAB, everything, MIXED_FNS);
  write(NEW_TAB, fresh, MIXED_FNS);

  if (tabsCreated_) { tabsCreated_ = false; orderTabs_(); }
}

/** Run this once from the editor (and again any time you want formatting refreshed -
 *  e.g. after changing SHEET_DEFS colors, or to fix a column width you changed by hand).
 *  Never touches data rows. */
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  allTabs_().forEach(function (def) {
    var sh = getOrCreateSheet_(def.name, def.color);
    try { formatSheet_(sh, def.color); } catch (e) { Logger.log('format ' + def.name + ' failed: ' + e); }
  });
  ss.getSheets().forEach(function (s) {
    var keep = allTabs_().some(function (d) { return d.name === s.getName(); });
    if (!keep && s.getLastRow() === 0) {
      try { ss.deleteSheet(s); } catch (e) { /* can't delete the only sheet left; ignore */ }
    }
  });
  orderTabs_();
  SpreadsheetApp.flush();
}

/* ====================== HTTP entry points ====================== */
function doPost(e) {
  // one writer at a time: two overlapping rewrites used to be able to overwrite each other
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (lockErr) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'busy, try again' }));
  }
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;

    if (action === 'upsert') {
      applyChangeAndRewriteAll_(function (master) {
        master[body.id] = recFrom_(body.id, body.data);
      });
      return ContentService.createTextOutput(JSON.stringify({ ok: true }));
    }

    if (action === 'adopt') {
      // the platform created records for rows typed into the sheet: store them (with IDs) and drop the typed-in copies
      var count = 0;
      applyChangeAndRewriteAll_(function (master) {
        var out = [];
        (body.rows || []).forEach(function (r) {
          master[r.id] = recFrom_(r.id, r.data);
          out.push(master[r.id]);
          count++;
        });
        return out;
      });
      return ContentService.createTextOutput(JSON.stringify({ ok: true, count: count }));
    }

    if (action === 'delete') {
      applyChangeAndRewriteAll_(function (master) { delete master[body.id]; });
      return ContentService.createTextOutput(JSON.stringify({ ok: true }));
    }

    if (action === 'bulkUpsert') {
      applyChangeAndRewriteAll_(function (master) {
        Object.keys(master).forEach(function (id) { delete master[id]; }); // bulk payload is authoritative
        (body.rows || []).forEach(function (r) { master[r.id] = recFrom_(r.id, r.data); });
      });
      return ContentService.createTextOutput(JSON.stringify({ ok: true, count: (body.rows || []).length }));
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unknown action' }));
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err), stack: err.stack || '' }));
  } finally {
    try { lock.releaseLock(); } catch (relErr) {}
  }
}

/** Returns every tracked record (id-having rows, tagged with brand) plus any
 *  "unidentified" rows - real data rows that were typed straight into the Sheet
 *  by hand and so have no ID yet in the hidden column A. The app uses this to:
 *   (a) pull a frozen archived month's totals (Moliya > Oylar), and
 *   (b) two-way sync: find rows added directly in the Sheet, create a matching
 *       Firestore record for each, and let the next normal sync fold them in
 *       (which also wipes the old ID-less row so there's no duplicate). */
function exportAllData_(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var records = [];
  var unidentified = [];
  var seenIds = {};
  allTabs_().forEach(function (def) {
    var sh = ss.getSheetByName(def.name);
    if (!sh) return;
    var isBrandTab = SHEET_DEFS.some(function (d) { return d.name === def.name; });
    readRows_(sh).forEach(function (row, idx) {
      var id = row[0];
      var model = row[4];
      if (!id && !model && !row[6]) return; // blank/divider row
      var rec = {
        id: id || null, status: row[1] || 'stock', brand: isBrandTab ? def.key : '',
        source: sv_(row[2]), sourcePhone: sv_(row[3]), model: sv_(model),
        imeiBox: row[5] === 'Bor', imei: sv_(row[6]),
        buyDate: dateBack_(row[7]), buyTime: timeBack_(row[8]),
        sellDate: dateBack_(row[9]), sellTime: timeBack_(row[10]),
        buyPrice: row[11] === '' ? null : row[11], sellPrice: row[12] === '' ? null : row[12],
        buyer: sv_(row[13]), buyerPhone: sv_(row[14]),
        isNew: def.key === 'new' || row[15] === 'Yangi' || (row[15] !== 'Ishlatilgan' && isNewModel_(model))
      };
      if (id) {
        if (isBrandTab || def.key === 'new') {              // Barcha only repeats the others
          if (def.key === 'new') rec.brand = (row[16] === 'iphone' || row[16] === 'samsung') ? row[16] : 'other';
          if (!seenIds[id]) { seenIds[id] = true; records.push(rec); }
        }
      }
      else { rec.sheetName = def.name; rec.sheetRow = idx + 2; unidentified.push(rec); }
    });
  });
  var out = { ok: true, records: records, unidentified: unidentified, exportedAt: new Date().toISOString() };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** One script can read ANY of your monthly Sheets: the app passes the month's Sheet ID.
 *  Only spreadsheets that contain the VipMobile tabs (iPhone/Samsung/Boshqa) are served. */
function exportById_(id) {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(id)) return jsonOut_({ ok: false, error: 'bad sheet id' });
  var ss;
  try { ss = SpreadsheetApp.openById(id); }
  catch (err) { return jsonOut_({ ok: false, error: 'cannot open that Sheet (is it yours / shared with this account?)' }); }
  var hasTabs = SHEET_DEFS.some(function (d) { return !!ss.getSheetByName(d.name); });
  if (!hasTabs) return jsonOut_({ ok: false, error: 'that Sheet has no iPhone/Samsung/Boshqa tabs' });
  return exportAllData_(ss);
}
function jsonOut_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'export' && e.parameter.sheetId) return exportById_(e.parameter.sheetId);
  if (action === 'export') return exportAllData_();
  return ContentService.createTextOutput('VipMobile sync endpoint is running.');
}
