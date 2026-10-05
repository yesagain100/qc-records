/* iPhones and iPads (Yes Check Mobile) — the phone side of the portal.
 *
 * A phone's saved test is one row of mobile_audits. Beside its typed columns the row carries
 * the whole record in `snapshot`, and inside that the printouts exactly as the Mac that tested
 * the phone printed them (snapshot.print: label, certificate, report). Everything here reads
 * those, so the portal and the paper cannot disagree:
 *   - what the list asks the database for, and how one row is shaped for the table
 *   - the unit label (101 x 54 mm), the box label (57 x 32 mm), the test certificate and the
 *     test report, as HTML ready to print
 *   - what a record shows when it is opened
 * A record saved before printouts were kept with the test is rebuilt from its own fields.
 *
 * Honesty rule (same as the Mac side): nothing is upgraded. A test with no result says NOT
 * DONE, a lock that was not checked says so, and a certificate is only ever drawn from the one
 * the Mac issued for a phone that passed.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ small helpers
  function str(v) { return v == null ? "" : String(v); }
  function trim(v) { return str(v).trim(); }
  function esc(v) {
    return str(v).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  // A JSON list, whether the database handed it over as a list or as its text.
  function arr(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === "string" && v.charAt(0) === "[") {
      try { var p = JSON.parse(v); if (Array.isArray(p)) return p; } catch (e) { /* not a list */ }
    }
    return [];
  }
  function intOf(v) {
    if (v == null || v === "") return null;
    var n = parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
    return isNaN(n) ? null : n;
  }
  function pick(a, b) { return a != null ? a : (b != null ? b : null); }
  function uniq(list) {
    var seen = {}, out = [];
    list.forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }

  // ------------------------------------------------------------------ the tests' names
  // Probe's own names for its tests (ProbeBridge.swift, PROBE_TESTS_META), for a record that
  // only holds their ids.
  var TEST_NAMES = {
    sensors: "Motion (accel + gyro)", compass: "Magnetometer / compass", barometer: "Barometer",
    speaker: "Loudspeaker (tone test)", mic: "Bottom mic (tone test)", earpiece: "Earpiece (tone test)",
    cameras: "Cameras present", torch: "Flashlight", wifi: "Wi-Fi", bluetooth: "Bluetooth",
    cellular: "Cellular — SIM, network & data", biometric_hw: "Face ID / Touch ID hardware",
    display_caps: "Display capabilities", battery: "Battery & charging", ram: "RAM speed",
    cpu: "CPU + thermal", storage: "Storage read / write", gps: "GPS fix", nfc: "NFC reader",
    integrity: "Jailbreak / integrity", display: "Display / dead pixels", touch: "Multi-touch grid",
    haptics: "Vibration", buttons: "Volume buttons", brightness: "Brightness",
    biometric: "Face ID / Touch ID auth", forcetouch: "3D / Haptic Touch",
    micarray: "Microphones (front/rear/bottom)", rotation: "Screen rotation",
    proximity: "Proximity sensor", camera_quality: "Camera quality (each lens)",
    parts_authenticity: "Parts authenticity", power: "Side / Power button", action: "Action button",
    ringer: "Ring / Silent switch", camera_control: "Camera Control", call: "Call / network",
    wireless_charge: "Wireless charging", battery_drain: "Battery drain (off the cable)",
    nfc_scan: "NFC reader (tap a card)", pencil: "Apple Pencil (iPad)",
    keyboard: "Keyboard / Smart Connector (iPad)", stress_thermal: "Stress / thermal"
  };
  var TEST_ORDER = Object.keys(TEST_NAMES);
  function testName(id) { return TEST_NAMES[id] || str(id).replace(/_/g, " "); }

  // ------------------------------------------------------------------ the list
  // A saved phone test is about 16 KB, nearly all of it the snapshot (every test's reading, the
  // printouts, the part serials). The table needs a few dozen short fields, so the list asks
  // for those and leaves the snapshot for the one record that gets opened.
  var COLS = ["id", "serial", "test_number", "tested_at", "created_at", "technician", "entity",
    "result", "grade", "colour", "imei", "udid", "ios", "storage_total_gb", "battery_health",
    "battery_cycles", "activation_locked", "managed", "carrier_locked", "blacklisted",
    "failed_categories", "defects", "notes", "photo_count", "parts_authenticity", "client_uuid",
    "on_device"];
  // Kept only inside the snapshot.
  var SNAP_TEXT = ["model", "model_number", "region", "technician_username", "department",
    "warehouse", "tested_local", "timezone", "app_build", "probe_version", "save_reason",
    "carrier_lock", "sku", "product_sku", "bench_port"];
  var SNAP_JSON = ["blockers", "warnings", "parts_service"];
  // `stored` = mobile_audits has a stored column s_<field> for each of these (see the SQL in
  // sql/mobile_list_columns.sql). Until that has been run the same keys are read out of the
  // snapshot by the database, which costs it more per row but returns the identical answer.
  function listSelect(stored) {
    var snap = SNAP_TEXT.map(function (f) { return stored ? "s_" + f : "s_" + f + ":snapshot->>" + f; })
      .concat(SNAP_JSON.map(function (f) { return stored ? "s_" + f : "s_" + f + ":snapshot->" + f; }));
    return COLS.concat(snap).join(",");
  }

  // ------------------------------------------------------------------ one row
  // PASS / REVIEW / FAIL as the Mac saved it. REVIEW is a verdict of its own for a phone (not
  // every check is done, or something needs a second look) — never folded into anything else.
  function verdict(v) {
    v = trim(v).toUpperCase();
    if (!v) return "";
    if (v.indexOf("REJECT") > -1) return "REJECT";
    if (v.indexOf("INCOMPLETE") > -1) return "INCOMPLETE";
    if (v.indexOf("PASS") === 0) return "PASS";
    if (v.indexOf("FAIL") === 0) return "FAIL";
    if (v.indexOf("REVIEW") === 0) return "REVIEW";
    return "OTHER";
  }

  // Carrier lock, from the words the Mac saved: "unlocked (Settings: no SIM restrictions)",
  // "unlocked (takes the test SIM)", "locked (rejects the test SIM)", "locked (Settings: SIM
  // locked)", "not checked". The yes/no column is only a fallback: the Mac does not fill it.
  function carrier(words, flag) {
    var w = trim(words), l = w.toLowerCase();
    if (/^locked/.test(l)) return { state: "locked", words: w };
    if (/^unlocked/.test(l)) return { state: "clean", words: w };
    if (!w && flag === true) return { state: "locked", words: "locked" };
    if (!w && flag === false) return { state: "clean", words: "unlocked" };
    return { state: "unknown", words: w || "" };
  }

  // Apple's own Parts & Service check, in a few words for the table.
  var PART_WORDS = { used: "used", unknown: "unknown part", unfinished: "repair not finished", issue: "issue" };
  function partsSummary(parts, onPhone) {
    parts = arr(parts);
    if (parts.length) {
      var odd = parts.filter(function (p) { return p && p.status && p.status !== "genuine"; });
      if (!odd.length) return { state: "ok", words: "All genuine" };
      var bad = odd.some(function (p) { return p.status !== "used"; });
      return { state: bad ? "bad" : "warn",
               words: odd.map(function (p) { return str(p.part) + ": " + (PART_WORDS[p.status] || str(p.status)); }).join(" · ") };
    }
    if (onPhone === "pass") return { state: "ok", words: "Checked on the phone" };
    if (onPhone === "fail") return { state: "bad", words: "Problem" };
    return { state: "", words: "" };
  }

  // "128 GB" / "1 TB" as the Mac saved it; a bare number is gigabytes.
  function storageText(v) {
    var t = trim(v);
    if (!t) return "";
    if (/[a-z]/i.test(t)) return t;
    var n = parseFloat(t);
    if (isNaN(n)) return "";
    return n >= 1000 ? Math.round(n / 1024) + " TB" : n + " GB";
  }
  function storageGB(v) {
    var t = trim(v), n = parseFloat(t.replace(/[^0-9.]/g, ""));
    if (!t || isNaN(n)) return null;
    return /tb/i.test(t) ? n * 1024 : n;
  }

  // One fault as a short name the analysis can count: "Battery health 74% — below the 85%
  // floor" and "Battery health 77% — below the 80% floor" are the same fault.
  function faultTag(t) {
    t = trim(t);
    if (/^Battery health\b.*below/i.test(t)) return "Battery health below the floor";
    t = t.split(/ — | – | \(/)[0];
    t = t.replace(/\d+(\.\d+)?\s*(%|°C|mAh|mV|dBm|hPa|×)?/g, " ").replace(/\s{2,}/g, " ");
    t = t.replace(/^[\s\-–—·,;:]+|[\s\-–—·,;:]+$/g, "");
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
  }
  var GENERIC_FAIL = /^\d+ functional tests? FAILED$/i;
  var PARTS_FAIL = /^Parts authenticity check FAILED\s*—\s*/i;
  // Two checks are never part of the Mac's "N functional tests FAILED" count: when they fail it
  // gives each a line of its own (Verdict.swift, REQUIRED_ON_DEVICE).
  var NAMED = { parts_authenticity: /^Parts authenticity check FAILED/i, stress_thermal: /^Stress \/ thermal test FAILED/i };

  // The reasons behind the verdict. The Mac saves them in plain words (`blockers`); a record
  // from before it did only has the ids of the failed tests.
  function faultsOf(blockers, failedIds) {
    if (!blockers.length) {
      var plain = failedIds.map(testName);
      return { words: uniq(plain), tags: uniq(plain) };
    }
    // What the bare count counts, by name — so "1 functional test FAILED" says which one.
    var counted = failedIds.filter(function (id) { return !NAMED[id]; }).map(testName);
    // A named check that failed on the phone without getting a line of its own still counts.
    var unlisted = failedIds.filter(function (id) {
      return NAMED[id] && !blockers.some(function (b) { return NAMED[id].test(b); });
    }).map(testName);
    var words = blockers.map(function (b) {
      return GENERIC_FAIL.test(b) && counted.length ? b + ": " + counted.join(", ") : b;
    });
    var tags = [];
    blockers.forEach(function (b) {
      if (GENERIC_FAIL.test(b)) return;                         // counted by the tests' own names
      if (PARTS_FAIL.test(b)) {
        b.replace(PARTS_FAIL, "").split(" · ").forEach(function (p) { tags.push(trim(p.split(" — ")[0])); });
      } else tags.push(faultTag(b));
    });
    return { words: uniq(words), tags: uniq(tags.concat(counted, unlisted)) };
  }

  /** One mobile_audits row (whole, or the slim list row turned back into shape) → a table row. */
  function flat(r, techLabel) {
    r = r || {};
    var s = r.snapshot || {};
    var onDevice = r.on_device || s.on_device || {};
    if (typeof onDevice !== "object") onDevice = {};
    var ids = Object.keys(onDevice);
    var failedIds = ids.filter(function (k) { return onDevice[k] === "fail"; }).sort();
    var passed = ids.filter(function (k) { return onDevice[k] === "pass"; }).length;
    var f = faultsOf(arr(s.blockers).map(str), failedIds);
    var warnings = arr(s.warnings).map(str);
    var cosmetic = str(r.defects || s.defects).split(";").map(trim).filter(Boolean);
    var lock = carrier(s.carrier_lock, pick(r.carrier_locked, s.carrier_locked));
    var parts = partsSummary(s.parts_service, onDevice.parts_authenticity);
    var technician = r.technician || s.technician || "", username = s.technician_username || "";
    var storage = pick(r.storage_total_gb, s.storage_total_gb);
    return {
      id: r.id, tested_at: r.tested_at || s.timestamp || r.created_at, serial: r.serial || s.serial || "",
      model: s.model || r.model || s.marketing_name || "",
      model_number: str(s.model_number) + str(s.region),
      imei: r.imei || s.imei || "", udid: r.udid || s.udid || "", ios: r.ios || s.ios || "",
      storage: storageGB(storage), storage_text: storageText(storage),
      colour: r.colour || s.colour || "", sku: s.sku || s.product_sku || "",
      technician: technician, technician_username: username,
      tech_disp: techLabel ? techLabel(technician, username) : technician,
      department: s.department || "",
      // `entity` is the site (UAE / France / UK), which is what the region filter groups by.
      warehouse: r.entity || s.entity || s.warehouse || "",
      tested_local: localStamp(s.tested_local), timezone: s.timezone || "",
      grade: str(r.grade || s.grade).toUpperCase(),
      result: verdict(r.result || s.result), result_raw: r.result || s.result || "",
      batt_h: intOf(pick(r.battery_health, s.battery_health)), batt_c: intOf(pick(r.battery_cycles, s.battery_cycles)),
      activation_locked: pick(r.activation_locked, s.activation_locked), managed: pick(r.managed, s.managed),
      carrier: lock.state, carrier_words: lock.words,
      carrier_locked: lock.state === "locked" ? true : (lock.state === "clean" ? false : null),
      blacklisted: pick(r.blacklisted, s.blacklisted),
      parts: parts.words, parts_state: parts.state,
      on_device: onDevice, checks_passed: passed, checks_failed: failedIds.length, checks_total: ids.length,
      save_reason: s.save_reason || "", probe_version: s.probe_version || "", app_build: s.app_build || "",
      port: s.bench_port == null ? "" : str(s.bench_port),
      test_number: r.test_number == null ? "" : r.test_number,
      photos: r.photo_count || s.photo_count || 0, notes: r.notes || s.notes || "",
      client_uuid: r.client_uuid || s.client_uuid || "",
      faults: f.words.join("; "), fault_tags: f.tags,
      warnings: warnings.join("; "), cosmetic: cosmetic.join("; "),
      _raw: r
    };
  }

  // ------------------------------------------------------------------ dates
  // The Mac stamps its printouts in its own local time; `tz` is the zone it saved with the
  // test, so an id or a date drawn here reads the same as on the paper.
  function dateParts(iso, tz) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return null;
    var o = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    var fmt;
    try { fmt = new Intl.DateTimeFormat("en-GB", tz ? Object.assign({ timeZone: tz }, o) : o); }
    catch (e) { fmt = new Intl.DateTimeFormat("en-GB", o); }      // a zone this browser does not know
    var out = {};
    fmt.formatToParts(d).forEach(function (p) { out[p.type] = p.value; });
    return out;
  }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function stamp(iso, tz) {                                  // 261005-2210
    var p = dateParts(iso, tz);
    return p ? p.year.slice(2) + p.month + p.day + "-" + p.hour + p.minute : "";
  }
  function longDate(iso, tz, withTime) {                     // 05 Oct 2026, 22:10
    var p = dateParts(iso, tz);
    if (!p) return "";
    return p.day + " " + MONTHS[parseInt(p.month, 10) - 1] + " " + p.year + (withTime ? ", " + p.hour + ":" + p.minute : "");
  }
  // The Mac stamps "2026-10-05 22:10:01" (its own wall clock). Shown the way its printouts
  // write a date — "05 Oct 2026, 22:10" — and left alone if it is in any other shape.
  function localStamp(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(trim(v));
    if (!m || !MONTHS[+m[2] - 1]) return trim(v);
    return m[3] + " " + MONTHS[+m[2] - 1] + " " + m[1] + ", " + m[4] + ":" + m[5];
  }
  function alnum(v) { return str(v).replace(/[^A-Za-z0-9]/g, ""); }
  function reportId(rep, tz) { var s = stamp(rep.tested, tz); return "YR-" + alnum(rep.serial) + (s ? "-" + s : ""); }
  function certificateId(c, tz) { var s = stamp(c.issued, tz); return "YC-" + alnum(c.serial) + (s ? "-" + s : ""); }

  // ------------------------------------------------------------------ the printouts of one test
  var LABEL0 = { verdict: "", model: "", capacity: "", colour: "", modelNumber: "", ios: "", grade: "",
    port: "", sku: "", battery: "—", cycles: "—", parts: "—", sim: "—", icloud: "—", tests: "—",
    faults: [], cosmetic: [], imei: "", serial: "", date: "", tech: "", warehouse: "" };
  var REPORT0 = { verdict: "review", grade: "", gradeMeaning: "", title: "", serial: "", imei: "",
    blockers: [], warnings: [], greens: [], device: [], locks: [], battery: [], health: [], parts: [],
    partSerials: [], tests: [], cosmetic: [], cosmeticNote: "", footer: "", versions: "", tested: "",
    clientUUID: "", erasedOn: "" };
  function fill(base, o) {
    var out = {};
    Object.keys(base).forEach(function (k) {
      var v = o && o[k];
      out[k] = v == null ? (Array.isArray(base[k]) ? [] : base[k]) : v;
    });
    return out;
  }

  // ------------------------------------------------------------------ cosmetic marks on the label
  // The marks tapped on the phone, as the unit label prints them (owner, 5 Oct 2026: "The product label
  // need to also mention any cosmetic defects"): grouped by the face they are on, in the order the faces
  // were marked, a repeated mark counted once with ×N — "Front: Glass cracked ×2, Frame dent". The Mac
  // saves the groups with the label from that day on; for a test saved before, they are worked out here
  // from its list of marks ("Glass cracked (Front); Frame dent (Front)") the same way.
  function cosmeticGroups(defects) {
    var faces = [], byFace = {};
    str(defects).split(";").map(trim).filter(Boolean).forEach(function (item) {
      var m = /^(.*) \(([^()]*)\)$/.exec(item);
      var label = m ? trim(m[1]) : item, face = m && trim(m[2]) ? trim(m[2]) : "Body";
      if (!label) return;
      if (!byFace[face]) { byFace[face] = []; faces.push(face); }
      var hit = byFace[face].filter(function (x) { return x[0] === label; })[0];
      if (hit) hit[1]++; else byFace[face].push([label, 1]);
    });
    return faces.map(function (f) {
      return f + ": " + byFace[f].map(function (x) { return x[1] > 1 ? x[0] + " ×" + x[1] : x[0]; }).join(", ");
    });
  }
  // One line, two when there are many: whole groups to a line while they fit (about 88 letters at this
  // size); what does not fit on the second is cut with "…" by the label itself.
  var COSMETIC_LINE = 88;
  function cosmeticLines(groups) {
    groups = arr(groups).map(str).filter(Boolean);
    if (!groups.length) return [];
    var lines = ["COSMETIC  "];
    groups.forEach(function (g, i) {
      var cur = lines[lines.length - 1];
      var piece = (/ {2}$/.test(cur) || !cur ? "" : " · ") + g;
      if ((cur + piece).length <= COSMETIC_LINE || lines.length === 2 || i === 0) lines[lines.length - 1] = cur + piece;
      else lines.push(g);
    });
    return lines;
  }

  /** The whole record: the snapshot, with the row's own columns laid over it. */
  function record(raw) {
    raw = raw || {};
    var rec = {}, s = raw.snapshot || {};
    Object.keys(s).forEach(function (k) { rec[k] = s[k]; });
    Object.keys(raw).forEach(function (k) {
      if (k === "snapshot" || k.charAt(0) === "_" || raw[k] == null || raw[k] === "") return;
      rec[k] = raw[k];
    });
    return rec;
  }

  /**
   * Label, certificate and report of one saved test.
   * `kept` true = they are the ones the Mac printed; false = rebuilt here from the saved fields
   * (a test saved before 5 Oct 2026), the same way the Mac's own Saved tests window does it.
   */
  function docs(raw) {
    var rec = record(raw), p = rec.print;
    var tz = rec.timezone || "";
    if (p && p.label && p.report) {
      var kept = fill(LABEL0, p.label);
      if (!arr(kept.cosmetic).length) kept.cosmetic = cosmeticGroups(rec.defects);     // saved before the label carried them
      return { kept: true, tz: tz, title: p.title || [rec.model, rec.serial].filter(Boolean).join(" · "),
               label: kept, report: fill(REPORT0, p.report),
               certificate: p.certificate || null, certificateReason: str(p.certificate_reason) };
    }
    var results = (rec.on_device && typeof rec.on_device === "object") ? rec.on_device : {};
    var reasons = rec.on_device_reasons || {}, details = rec.on_device_details || {};
    var blockers = arr(rec.blockers).map(str), warnings = arr(rec.warnings).map(str);
    var v = trim(rec.result).toLowerCase() || "review";
    var when = rec.timestamp || rec.tested_at || rec.created_at || "";
    var ids = Object.keys(results);
    var sku = rec.sku || rec.product_sku || "";
    var locked = rec.activation_locked;
    var label = fill(LABEL0, {
      verdict: v === "pass" ? "PASS" : (v === "fail" ? "FAIL" : "REVIEW"),
      model: rec.model, capacity: storageText(rec.storage_total_gb), colour: rec.colour, ios: rec.ios,
      modelNumber: str(rec.model_number) + str(rec.region), grade: rec.grade, sku: sku,
      port: rec.bench_port == null ? "" : str(rec.bench_port),
      battery: rec.battery_health || "—", cycles: rec.battery_cycles == null ? "—" : str(rec.battery_cycles),
      imei: rec.imei, serial: rec.serial,
      icloud: locked === true ? "ON" : (locked === false ? "Off" : "—"),
      tests: ids.length ? ids.filter(function (k) { return results[k] === "pass"; }).length + "/" + ids.length : "—",
      faults: blockers.map(function (b) { return "✗ " + b; }).concat(warnings.map(function (w) { return "! " + w; })),
      cosmetic: cosmeticGroups(rec.defects),
      date: longDate(when, tz, false), tech: rec.technician, warehouse: rec.warehouse || rec.entity
    });
    var known = TEST_ORDER.filter(function (id) { return results[id] != null; });
    var others = ids.filter(function (id) { return !TEST_NAMES[id]; }).sort();
    var report = fill(REPORT0, {
      verdict: v, grade: rec.grade,
      title: [rec.model, storageText(rec.storage_total_gb), rec.colour].filter(Boolean).join(" · "),
      serial: rec.serial, imei: rec.imei, blockers: blockers, warnings: warnings, greens: arr(rec.checks_clean),
      device: [{ k: "Model", v: str(rec.model) }, { k: "Storage", v: storageText(rec.storage_total_gb) },
               { k: "iOS", v: str(rec.ios) }, { k: "SKU", v: str(sku) }],
      locks: [{ k: "iCloud lock", v: locked === true ? "ON" : (locked === false ? "Off" : "not read"), tone: locked === true ? "bad" : "" },
              { k: "Carrier lock", v: str(rec.carrier_lock) || "not checked" }],
      tests: known.concat(others).map(function (id) {
        var res = results[id] === "na" ? "skip" : str(results[id]);
        return { name: testName(id), result: res, note: str(res === "fail" ? (reasons[id] || "") : (details[id] || reasons[id] || "")) };
      }),
      cosmetic: str(rec.defects).split(";").map(trim).filter(Boolean),
      footer: ["Tested " + longDate(when, tz, true), rec.technician, rec.warehouse || rec.entity].filter(Boolean).join(" · "),
      versions: "saved before 5 Oct 2026 — rebuilt from the saved fields",
      tested: when, clientUUID: rec.client_uuid
    });
    return { kept: false, tz: tz, title: [rec.model, rec.serial].filter(Boolean).join(" · "),
             label: label, report: report, certificate: null,
             certificateReason: "This test was saved before certificates were kept with the test." };
  }

  // ------------------------------------------------------------------ Code 128
  // Bars as an SVG the label scales to its own width. Digits are packed two to a symbol (set C)
  // wherever that is shorter, as the Mac's own labels do: a 15-digit IMEI takes 134 modules
  // instead of 200, which is what keeps it readable on the 57 mm box label.
  var C128 = ["212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
    "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
    "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
    "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
    "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
    "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
    "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
    "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
    "114131", "311141", "411131", "211412", "211214", "211232", "2331112"];
  function code128Values(text) {
    text = str(text).replace(/[^\x20-\x7e]/g, "");
    var n = text.length, vals = [], set = "", i = 0;
    function digitsAt(p) { var k = 0; while (p + k < n && text.charCodeAt(p + k) >= 48 && text.charCodeAt(p + k) <= 57) k++; return k; }
    while (i < n) {
      var d = digitsAt(i);
      // Set C pays for its switch with a run of 4 digits at either end, 6 in the middle.
      if (d >= ((i === 0 || i + d === n) ? 4 : 6)) {
        var run = d - (d % 2);
        if (set !== "C") { vals.push(set ? 99 : 105); set = "C"; }
        for (var k = 0; k < run; k += 2) vals.push(parseInt(text.substr(i + k, 2), 10));
        i += run;
      } else {
        if (set !== "B") { vals.push(set ? 100 : 104); set = "B"; }
        vals.push(text.charCodeAt(i) - 32);
        i++;
      }
    }
    if (!set) vals.push(104);
    var sum = vals[0];
    for (var j = 1; j < vals.length; j++) sum += vals[j] * j;
    vals.push(sum % 103);
    vals.push(106);
    return vals;
  }
  function code128(text) {
    if (!trim(text)) return "";
    var mods = code128Values(text).map(function (v) { return C128[v]; }).join("");
    var x = 0, rects = "";
    for (var i = 0; i < mods.length; i++) {
      var w = +mods.charAt(i);
      if (i % 2 === 0) rects += '<rect x="' + x + '" y="0" width="' + w + '" height="10"/>';
      x += w;
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + x + ' 10" preserveAspectRatio="none" shape-rendering="crispEdges">' + rects + "</svg>";
  }

  // ------------------------------------------------------------------ labels
  // Black only (thermal). Laid out in millimetres to the Mac's own drawing (UnitLabels.swift).
  var LABEL_SIZES = [
    { id: "unit", name: "Unit label 101 × 54 mm (DyMo 99014)", w: 101, h: 54 },
    { id: "box", name: "Box label 57 × 32 mm (DyMo 30334)", w: 57, h: 32 }
  ];
  function labelSize(id) { return LABEL_SIZES.filter(function (s) { return s.id === id; })[0] || LABEL_SIZES[0]; }

  function labelCSS(id) {
    var z = labelSize(id);
    var sans = '-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif';
    var mono = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';
    return "@page{size:" + z.w + "mm " + z.h + "mm;margin:0}" +
      "*{box-sizing:border-box}html,body{margin:0;padding:0}" +
      ".pl{width:" + z.w + "mm;height:" + z.h + "mm;font-family:" + sans + ";color:#000;background:#fff;position:relative;overflow:hidden;page-break-after:always}" +
      ".pl:last-child{page-break-after:auto}" +
      ".pl .one{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".pl .sq{flex:none;border:.5mm solid #000;border-radius:.9mm;text-align:center;overflow:hidden}" +
      ".pl .sq.fill{background:#000;color:#fff}" +
      ".pl .sq .k{font-weight:800;letter-spacing:.05mm}.pl .sq .v{font-weight:900}" +
      ".pl .bcr{display:flex}" +
      ".pl .bcr .k{flex:none;display:flex;align-items:center;font-weight:800}" +
      ".pl .bcr .b{flex:1;min-width:0}" +
      ".pl .bcr .bars svg{display:block;width:100%;height:100%}" +
      ".pl .bcr .n{font-family:" + mono + ";font-weight:600;margin-top:.3mm}" +
      ".pl .mono{font-family:" + mono + "}" +
      // 101 x 54
      ".pl.unit{padding:2.4mm 3mm 0}" +
      ".pl.unit .r1{display:flex;gap:1.6mm;height:9mm;align-items:flex-start}" +
      ".pl.unit .vd{flex:none;height:6.4mm;padding:0 1.5mm;border:.55mm solid #000;border-radius:.9mm;font-size:3.5mm;font-weight:900;line-height:5.3mm;white-space:nowrap;margin-right:.4mm}" +
      ".pl.unit .vd.pass{background:#000;color:#fff}" +
      ".pl.unit .ttl{flex:1;min-width:0}" +
      ".pl.unit .t1{font-size:3.5mm;font-weight:800;line-height:4.5mm}" +
      ".pl.unit .t2{font-size:2.2mm;line-height:3mm}" +
      ".pl.unit .sq{width:10mm;height:9mm}" +
      ".pl.unit .sq .k{font-size:1.55mm;line-height:2mm;margin-top:.2mm}.pl.unit .sq .v{font-size:5.4mm;line-height:5.7mm}" +
      ".pl.unit .sku{font-size:2.9mm;font-weight:700;margin-top:1.1mm;height:4.2mm;line-height:3.6mm;white-space:pre;overflow:hidden}" +
      ".pl.unit .specs{display:grid;grid-template-columns:repeat(6,1fr);height:6.6mm;border:.35mm solid #000;border-radius:.8mm}" +
      ".pl.unit .specs>div{padding:.45mm .8mm 0;border-left:.35mm solid #000;min-width:0}" +
      ".pl.unit .specs>div:first-child{border-left:0}" +
      ".pl.unit .specs .k{font-size:1.5mm;font-weight:800;line-height:1.9mm}" +
      ".pl.unit .specs .v{font-size:2.6mm;font-weight:700;line-height:3.3mm}" +
      ".pl.unit .flt{border:.35mm solid #000;border-radius:.8mm;padding:.4mm 1mm}" +
      ".pl.unit .flt div{font-size:1.8mm;font-weight:700;line-height:2.05mm}" +
      ".pl.unit .cos{margin-top:.95mm}.pl.unit .cos div{font-size:1.8mm;font-weight:700;line-height:2.15mm}" +
      ".pl.unit .bcr{margin-top:1.3mm}.pl.unit .cos+.bcr,.pl.unit .bcr+.bcr{margin-top:.8mm}" +
      ".pl.unit .bcr .k{width:6mm;font-size:1.7mm}" +
      ".pl.unit .bcr .n{font-size:2mm;line-height:2.6mm}" +
      ".pl.unit .ft{position:absolute;left:3mm;right:3mm;bottom:0;height:4.2mm;border-top:.3mm solid #000;padding-top:.4mm;display:flex;justify-content:space-between;gap:3mm;font-size:1.8mm;line-height:2.4mm;white-space:nowrap}" +
      // 57 x 32
      ".pl.box{padding:2mm 2mm 0}" +
      ".pl.box .r1{display:flex;gap:1.2mm;height:7.6mm}" +
      ".pl.box .ttl{flex:1;min-width:0}" +
      ".pl.box .t1{font-size:2.9mm;font-weight:800;line-height:3.5mm}" +
      ".pl.box .t2{font-size:1.9mm;font-weight:600;line-height:2.3mm}" +
      ".pl.box .t3{font-size:1.7mm;line-height:2.1mm}" +
      ".pl.box .sq{width:7.6mm;height:7.6mm}" +
      ".pl.box .sq .k{font-size:1.55mm;line-height:2mm;margin-top:.2mm}.pl.box .sq .v{font-size:4.2mm;line-height:4.5mm}" +
      ".pl.box .bcr{margin-top:1.2mm}" +
      ".pl.box .bcr .k{width:5.4mm;font-size:1.7mm}" +
      ".pl.box .bcr .n{font-size:1.9mm;line-height:2.4mm}" +
      ".pl.box .last{display:flex;justify-content:space-between;align-items:baseline;gap:2mm;margin-top:.6mm;white-space:nowrap}" +
      ".pl.box .last .s{font-size:2.1mm;font-weight:700;min-width:0}" +
      ".pl.box .last .d{font-size:1.6mm;flex:none}";
  }

  function square(title, value, filled) {
    return '<div class="sq' + (filled ? " fill" : "") + '"><div class="k">' + title + '</div><div class="v">' + (esc(value) || "–") + "</div></div>";
  }
  function barcodeRow(name, value, barMM) {
    return '<div class="bcr"><div class="k" style="height:' + barMM + 'mm">' + name + '</div><div class="b">' +
      '<div class="bars" style="height:' + barMM + 'mm">' + code128(value) + '</div><div class="n">' + esc(value) + "</div></div></div>";
  }

  /** One label. `u` = the label as saved (docs(row).label); `id` = "unit" or "box". */
  function labelHTML(u, id) {
    u = fill(LABEL0, u);
    var title = [u.model, u.capacity].filter(Boolean).join(" · ");
    if (labelSize(id).id === "box") {
      return '<div class="pl box"><div class="r1"><div class="ttl">' +
        '<div class="t1 one">' + esc(title) + "</div>" +
        '<div class="t2 one">' + esc([u.verdict, u.colour].filter(Boolean).join(" · ")) + "</div>" +
        '<div class="t3 one mono">S/N ' + esc(u.serial) + "</div></div>" +
        square("GRADE", u.grade, false) + square("PORT", u.port, true) + "</div>" +
        barcodeRow("IMEI", u.imei, 8.6) +
        '<div class="last"><div class="s one mono">' + (esc(u.sku) || "SKU —") + '</div><div class="d">YesAgain · ' + esc(u.date) + "</div></div></div>";
    }
    var pass = u.verdict === "PASS";
    var faults = arr(u.faults).slice(0, 3);
    var showFaults = !pass && faults.length > 0;
    var cosmetic = cosmeticLines(u.cosmetic);
    // The barcodes give up the room the fault lines need, exactly as on the Mac's label — and are as tall
    // as planned unless the cosmetic lines have taken their room too. In millimetres from the top edge:
    // 2.4 margin, 9 heading, 5.3 SKU, the box, the lines, two barcodes with their numbers (2.9 each) and
    // 0.8 between them, and nothing below 49.3 (the footer rule sits at 49.8).
    var planned = showFaults ? 6.9 - 0.9 * Math.max(0, faults.length - 1) : 7.4;
    var box = showFaults ? 1.5 + 2.05 * faults.length : 6.6;
    var above = 2.4 + 9 + 5.3 + box + (cosmetic.length ? 0.95 + 2.15 * cosmetic.length + 0.8 : 1.3);
    var room = (49.3 - above - 0.8 - 2 * 2.9) / 2;
    var barMM = Math.round(Math.max(4.4, Math.min(planned, room)) * 100) / 100;
    var sub = [u.colour, u.modelNumber, u.ios ? "iOS " + u.ios : ""].filter(Boolean).join(" · ");
    var middle;
    if (showFaults) {
      middle = '<div class="flt">' + faults.map(function (f) { return '<div class="one">' + esc(f) + "</div>"; }).join("") + "</div>";
    } else {
      middle = '<div class="specs">' + [["BATTERY", u.battery], ["CYCLES", u.cycles], ["PARTS", u.parts], ["SIM", u.sim],
        ["iCLOUD", u.icloud], ["TESTS", u.tests]].map(function (x) {
          return '<div><div class="k">' + x[0] + '</div><div class="v one">' + esc(x[1]) + "</div></div>";
        }).join("") + "</div>";
    }
    var left = ["Tested " + u.date, u.tech].filter(function (x) { return x && x !== "Tested "; }).join(" · ");
    var right = [u.warehouse, "Yes Check"].filter(Boolean).join(" · ");
    return '<div class="pl unit"><div class="r1">' +
      '<div class="vd' + (pass ? " pass" : "") + '">' + (esc(u.verdict) || "—") + "</div>" +
      '<div class="ttl"><div class="t1 one">' + esc(title) + '</div><div class="t2 one">' + esc(sub) + "</div></div>" +
      square("GRADE", u.grade, false) + square("PORT", u.port, true) + "</div>" +
      '<div class="sku mono">SKU  ' + (esc(u.sku) || "—") + "</div>" + middle +
      (cosmetic.length ? '<div class="cos">' + cosmetic.map(function (l) { return '<div class="one">' + esc(l) + "</div>"; }).join("") + "</div>" : "") +
      barcodeRow("IMEI", u.imei, barMM) + barcodeRow("S/N", u.serial, barMM) +
      '<div class="ft"><span class="one">' + esc(left) + "</span><span>" + esc(right) + "</span></div></div>";
  }

  // ------------------------------------------------------------------ shared by the two A4 pages
  var NAVY = "#112747", ORANGE = "#fbb03b", ORANGE_INK = "#a8660a", GREEN = "#12804a", AMBER = "#b46b00",
      RED = "#c6282b", MUTED = "#5d6a7f", RULE = "#e6eaf0", WASH = "#f5f7fa";
  var A4_FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","Helvetica Neue",Arial,sans-serif';
  var A4_MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';
  function toneColor(t) { return t === "ok" ? GREEN : (t === "warn" ? AMBER : (t === "bad" ? RED : NAVY)); }
  function kvTable(rows) {
    return '<table class="kvt">' + arr(rows).map(function (r) {
      return '<tr><td class="k">' + esc(r.k) + '</td><td class="v" style="color:' + toneColor(r.tone) + '">' + (esc(r.v) || "—") + "</td></tr>";
    }).join("") + "</table>";
  }
  function titled(title, rows) {
    return arr(rows).length ? '<div class="blk"><div class="cap">' + esc(title) + "</div>" + kvTable(rows) + "</div>" : "";
  }

  // ------------------------------------------------------------------ certificate
  function certificateCSS() {
    return "@page{size:A4;margin:0}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}" +
      "html,body{margin:0;padding:0}" +
      ".pc{width:210mm;height:296.5mm;padding:14pt;font-family:" + A4_FONT + ";color:" + NAVY + ";background:#fff;overflow:hidden}" +
      ".pc .fr{position:relative;height:100%;border:3pt solid " + ORANGE + ";padding:24pt 27pt 0}" +
      ".pc .hd{display:flex;justify-content:space-between;align-items:flex-start}" +
      ".pc .hd img{height:26pt;display:block}" +
      ".pc .hd .id{font-family:" + A4_MONO + ";font-size:8.5pt;color:" + MUTED + ";text-align:right;line-height:12pt}" +
      ".pc .hd .id b{font-weight:600}" +
      ".pc h1{font-size:25pt;font-weight:800;margin:24pt 0 12pt;letter-spacing:-.3pt}" +
      ".pc .vr{display:flex;align-items:center;gap:10pt;margin-bottom:22pt}" +
      ".pc .pill{background:" + GREEN + ";color:#fff;border-radius:5pt;width:86pt;height:26pt;line-height:26pt;text-align:center;font-size:13pt;font-weight:800}" +
      ".pc .gr{border:2pt solid " + NAVY + ";border-radius:5pt;width:86pt;height:26pt;line-height:22pt;text-align:center;font-size:13pt;font-weight:800}" +
      ".pc .gm{flex:1;font-size:9.5pt;color:" + MUTED + ";line-height:12.5pt;margin-left:2pt}" +
      ".pc .two{display:grid;grid-template-columns:1fr 1fr;gap:0 24pt}" +
      ".pc .cap{font-size:8.5pt;font-weight:700;color:" + ORANGE_INK + ";text-transform:uppercase;letter-spacing:.2pt;margin-bottom:3pt}" +
      ".pc .kvt{width:100%;border-collapse:collapse}" +
      ".pc .kvt td{font-size:9.5pt;padding:3pt 0 3.6pt;border-bottom:.7pt solid " + RULE + ";vertical-align:top;line-height:12pt}" +
      ".pc .kvt td.k{width:42%;color:" + MUTED + "}.pc .kvt td.v{font-weight:600}" +
      ".pc .chk{margin-top:22pt}" +
      ".pc .chk .list{display:grid;grid-template-columns:1fr 1fr;grid-auto-flow:column;gap:0 24pt;margin-top:4pt}" +
      ".pc .chk .c{font-size:9.5pt;line-height:13.5pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".pc .chk .c b{color:" + GREEN + ";display:inline-block;width:13pt}" +
      ".pc .ft{position:absolute;left:27pt;right:27pt;bottom:26pt;height:84pt;border-top:.8pt solid " + RULE + ";padding-top:10pt;display:flex;gap:12pt;align-items:flex-start}" +
      ".pc .ft .qr{flex:none;width:74pt;height:74pt}.pc .ft .qr svg{width:100%;height:100%;display:block}" +
      ".pc .ft .st{flex:1;font-size:8.5pt;color:" + MUTED + ";line-height:11pt}" +
      ".pc .ft .bc{flex:none;width:200pt;text-align:center;padding-top:8pt}" +
      ".pc .ft .bc .bars{height:40pt}.pc .ft .bc svg{width:100%;height:100%;display:block}" +
      ".pc .ft .bc .n{font-family:" + A4_MONO + ";font-size:8.5pt;font-weight:600;margin-top:4pt}" +
      ".pc.none .fr{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40pt}" +
      ".pc.none h2{font-size:18pt;margin:18pt 0 8pt;color:" + RED + "}.pc.none p{font-size:11pt;color:" + MUTED + ";max-width:360pt;line-height:16pt;margin:4pt 0}";
  }

  /**
   * The test certificate. Drawn ONLY from the certificate the Mac issued — which it does for a
   * phone that passed and for no other. Anything else gets a page saying why there is none.
   * env: { logo, qr(url) → svg, verifyURL(serial, testId) → url }
   */
  function certificateHTML(d, env) {
    env = env || {};
    var c = d && d.certificate;
    if (!c) {
      var rep = (d && d.report) || {};
      return '<div class="pc none"><div class="fr">' + (env.logo ? '<img src="' + esc(env.logo) + '" alt="YesAgain" style="height:30pt">' : "") +
        "<h2>No certificate for this test</h2>" +
        "<p>" + (esc(d && d.certificateReason) || "Certificates are issued for phones that pass, and this one has none on file.") + "</p>" +
        "<p>Serial " + (esc(rep.serial) || "—") + " · result " + (esc(str(rep.verdict).toUpperCase()) || "—") + "</p></div></div>";
    }
    var tz = (d && d.tz) || "";
    var device = [["Model", c.model], ["Model number", c.modelNumber], ["Storage", c.capacity], ["Colour", c.colour || "—"],
      ["iOS", c.ios], ["IMEI", c.imei], ["Serial", c.serial], ["SKU", c.sku || "—"]];
    var batt = [["Battery health", c.battery || "—"], ["Charge cycles", c.cycles || "—"]];
    if (c.peakTemp) batt.push(["Peak temperature", c.peakTemp]);
    batt.push(["Parts & Service", c.parts || "—"], ["iCloud / MDM", c.locks || "—"], ["SIM", c.sim || "—"]);
    var rows = function (list) { return list.map(function (x) { return { k: x[0], v: x[1] }; }); };
    var checks = arr(c.checks);
    var per = Math.ceil(checks.length / 2);
    var statement = "Scan to check this certificate on the YesAgain QC records.";
    if (c.erasedOn) statement += " Data erased " + c.erasedOn + " with Apple's Erase All Content & Settings.";
    var bench = [c.port ? "bench PORT " + c.port : "", c.tech ? "by " + c.tech : "", c.warehouse || ""].filter(Boolean);
    if (bench.length) statement += " Tested on " + bench.join(", ") + ".";
    var url = env.verifyURL ? env.verifyURL(c.serial, c.clientUUID) : "";
    return '<div class="pc"><div class="fr">' +
      '<div class="hd">' + (env.logo ? '<img src="' + esc(env.logo) + '" alt="YesAgain">' : "<b>yesagain</b>") +
      '<div class="id"><b>Certificate ' + esc(certificateId(c, tz)) + "</b><br>Issued " + esc(longDate(c.issued, tz, true)) + "</div></div>" +
      "<h1>Device test certificate</h1>" +
      '<div class="vr"><div class="pill">PASSED</div><div class="gr">GRADE ' + (esc(c.grade) || "–") + '</div><div class="gm">' + esc(c.gradeMeaning) + "</div></div>" +
      '<div class="two"><div><div class="cap">Device</div>' + kvTable(rows(device)) + '</div><div><div class="cap">Battery &amp; parts</div>' + kvTable(rows(batt)) + "</div></div>" +
      '<div class="chk"><div class="cap">' + checks.length + ' checks passed</div><div class="list" style="grid-template-rows:repeat(' + Math.max(1, per) + ',auto)">' +
      checks.map(function (x) { return '<div class="c"><b>✓</b>' + esc(x) + "</div>"; }).join("") + "</div></div>" +
      '<div class="ft"><div class="qr">' + (env.qr && url ? env.qr(url) : "") + '</div><div class="st">' + esc(statement) + "</div>" +
      '<div class="bc"><div class="bars">' + code128(c.serial) + '</div><div class="n">' + esc(c.serial) + "</div></div></div>" +
      "</div></div>";
  }

  // ------------------------------------------------------------------ report
  function reportCSS() {
    return "@page{size:A4;margin:10mm 12mm 10mm}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}" +
      "html,body{margin:0;padding:0}" +
      ".pr{font-family:" + A4_FONT + ";color:" + NAVY + ";font-size:8.9pt;line-height:1.3;background:#fff}" +
      ".pr .band{background:" + NAVY + ";border-bottom:3pt solid " + ORANGE + ";color:#fff;display:flex;justify-content:space-between;align-items:center;padding:13pt 18pt;border-radius:5pt 5pt 0 0}" +
      ".pr .band img{height:24pt;display:block}" +
      ".pr .band .t{text-align:right}.pr .band .t b{display:block;font-size:15pt;font-weight:800}" +
      ".pr .band .t span{font-family:" + A4_MONO + ";font-size:8.5pt;font-weight:500;opacity:.8}" +
      ".pr .body{padding:18pt 2pt 0}" +
      ".pr .vr{display:flex;align-items:flex-start;gap:10pt}" +
      ".pr .pill{flex:none;color:#fff;border-radius:6pt;height:28pt;line-height:28pt;padding:0 13pt;font-size:14pt;font-weight:800}" +
      ".pr .gr{flex:none;border:2pt solid " + NAVY + ";border-radius:6pt;height:28pt;line-height:24pt;width:92pt;text-align:center;font-size:14pt;font-weight:800}" +
      ".pr .ttl{flex:1;min-width:0;margin-left:2pt}" +
      ".pr .ttl b{display:block;font-size:15pt;font-weight:800;line-height:17pt}" +
      ".pr .ttl span{font-family:" + A4_MONO + ";font-size:8.8pt;font-weight:500;color:" + MUTED + "}" +
      ".pr .gm{font-size:9pt;color:" + MUTED + ";margin:10pt 0 0}" +
      ".pr .why{background:" + WASH + ";border-radius:5pt;padding:6pt 10pt;margin:10pt 0 14pt}" +
      ".pr .why div{display:flex;gap:6pt;font-size:9.6pt;font-weight:500;padding:2pt 0}" +
      ".pr .why div b{flex:none;width:11pt;font-size:10pt;font-weight:800}" +
      ".pr .why .ok{font-size:10pt;font-weight:600;color:" + GREEN + "}" +
      ".pr .two{display:grid;grid-template-columns:1fr 1fr;gap:0 24pt;align-items:start}" +
      ".pr .blk{margin-bottom:9pt}" +
      ".pr .cap{font-size:8.2pt;font-weight:700;color:" + ORANGE_INK + ";text-transform:uppercase;letter-spacing:.2pt;margin-bottom:3pt;break-after:avoid}" +
      ".pr .kvt{width:100%;border-collapse:collapse}" +
      ".pr .kvt tr{break-inside:avoid}" +
      ".pr .kvt td{padding:1.6pt 0 2.4pt;border-bottom:.6pt solid " + RULE + ";vertical-align:top}" +
      ".pr .kvt td.k{width:42%;color:" + MUTED + ";padding-right:6pt}.pr .kvt td.v{font-weight:600;word-break:break-word}" +
      ".pr .one .kvt td.k{width:30%}" +
      ".pr h3{font-size:8.5pt;font-weight:700;color:" + ORANGE_INK + ";text-transform:uppercase;letter-spacing:.2pt;border-bottom:.8pt solid " + RULE + ";padding-bottom:3pt;margin:6pt 0 6pt;break-after:avoid}" +
      ".pr .tests{column-count:2;column-gap:24pt}" +
      ".pr .tt{break-inside:avoid;display:grid;grid-template-columns:14pt 1fr 48pt;padding:.6pt 0 .8pt}" +
      ".pr .tt .m{font-size:9.2pt;font-weight:800}.pr .tt .nm{font-size:9pt}" +
      ".pr .tt .w{font-size:7pt;font-weight:800;text-align:right;padding-top:1.5pt}" +
      ".pr .tt .nt{grid-column:2;font-size:7.6pt;color:" + MUTED + ";line-height:9.6pt}" +
      ".pr .tt.fail .nm{font-weight:600;color:" + RED + "}.pr .tt.fail .nt{color:" + RED + "}" +
      ".pr .cos{font-size:9.2pt;margin-bottom:10pt}.pr .cos b{display:block;font-weight:600;margin-bottom:3pt}" +
      ".pr .hist{width:100%;border-collapse:collapse;margin-bottom:10pt}" +
      ".pr .hist th{font-size:7.4pt;text-transform:uppercase;letter-spacing:.2pt;color:" + MUTED + ";text-align:left;padding:2pt 6pt 3pt 0;border-bottom:.8pt solid " + RULE + "}" +
      ".pr .hist tr{break-inside:avoid}" +
      ".pr .hist td{font-size:8.6pt;padding:2pt 6pt 2.4pt 0;border-bottom:.6pt solid " + RULE + ";vertical-align:top}" +
      ".pr .hist tr.me td{font-weight:700}" +
      ".pr .sign{break-inside:avoid;border-top:.8pt solid " + RULE + ";margin-top:4pt;padding-top:10pt;display:flex;gap:12pt;align-items:flex-start}" +
      ".pr .sign .qr{flex:none;width:62pt;height:62pt}.pr .sign .qr svg{width:100%;height:100%;display:block}" +
      ".pr .sign .st{flex:1;font-size:8.3pt;color:" + MUTED + ";line-height:11pt}" +
      ".pr .sign .bc{flex:none;width:196pt;text-align:center}" +
      ".pr .sign .bc .bars{height:34pt}.pr .sign .bc svg{width:100%;height:100%;display:block}" +
      ".pr .sign .bc .n{font-family:" + A4_MONO + ";font-size:8.5pt;font-weight:600;margin-top:4pt}" +
      ".pr .foot{break-inside:avoid;break-before:avoid;margin-top:8pt;border-top:.8pt solid " + RULE + ";padding-top:5pt;color:" + MUTED + "}" +
      ".pr .foot div:first-child{font-size:7.8pt}.pr .foot div{font-size:7.2pt;line-height:11pt}";
  }

  var MARKS = { pass: ["✓", GREEN, "PASS"], fail: ["✗", RED, "FAIL"], "": ["○", MUTED, "NOT DONE"] };
  function testRow(t) {
    var res = str(t.result), m = MARKS[res] || ["–", MUTED, "SKIPPED"];
    return '<div class="tt' + (res === "fail" ? " fail" : "") + '"><span class="m" style="color:' + m[1] + '">' + m[0] + "</span>" +
      '<span class="nm">' + esc(t.name) + '</span><span class="w" style="color:' + m[1] + '">' + m[2] + "</span>" +
      (t.note ? '<span class="nt">' + esc(t.note) + "</span>" : "") + "</div>";
  }
  function reasonsHTML(r) {
    var blockers = arr(r.blockers), warnings = arr(r.warnings), greens = arr(r.greens);
    if (!blockers.length && !warnings.length) {
      return '<div class="why"><div class="ok">✓&nbsp; No faults found' + (greens.length ? " — " + greens.length + " checks clean" : "") + "</div></div>";
    }
    return '<div class="why">' +
      blockers.map(function (b) { return '<div style="color:' + RED + '"><b>✗</b><span>' + esc(b) + "</span></div>"; }).join("") +
      warnings.map(function (w) { return '<div style="color:' + AMBER + '"><b>!</b><span>' + esc(w) + "</span></div>"; }).join("") + "</div>";
  }
  function pair(left, right) {
    var l = left.join(""), rr = right.join("");
    if (!l && !rr) return "";
    if (!l || !rr) return '<div class="one">' + (l || rr) + "</div>";
    return '<div class="two"><div>' + l + "</div><div>" + rr + "</div></div>";
  }

  /**
   * The test report: the verdict and every reason behind it, locks, battery, Apple's parts
   * check, each fitted part's serial, every test with what it measured, the cosmetic marks.
   * Printed for any phone, pass or not.
   * env: { logo, qr(url) → svg, verifyURL(serial, testId) → url,
   *        history: [{ when, result, grade, tech, why, current }] — every test on record for the phone }
   */
  function reportHTML(d, env) {
    env = env || {};
    var r = fill(REPORT0, d && d.report), tz = (d && d.tz) || "";
    var v = str(r.verdict).toLowerCase();
    var word = v === "pass" ? "PASSED" : (v === "fail" ? "FAILED" : "REVIEW");
    var colour = v === "pass" ? GREEN : (v === "fail" ? RED : AMBER);
    var tests = arr(r.tests), cosmetic = arr(r.cosmetic);
    var passed = tests.filter(function (t) { return t.result === "pass"; }).length;
    var failed = tests.filter(function (t) { return t.result === "fail"; }).length;
    var waiting = tests.filter(function (t) { return !t.result; }).length;
    var statement = "Scan to open this test on the YesAgain QC records.";
    if (r.erasedOn) statement += " Data erased " + r.erasedOn + " with Apple's Erase All Content & Settings.";
    statement += " This report lists everything the bench and the phone's own test app recorded; a result marked NOT DONE was not tested.";
    var url = env.verifyURL ? env.verifyURL(r.serial, r.clientUUID) : "";
    var history = arr(env.history);
    var out = '<div class="pr"><div class="band">' + (env.logo ? '<img src="' + esc(env.logo) + '" alt="YesAgain">' : "<b>yesagain</b>") +
      '<div class="t"><b>Device test report</b><span>' + esc(reportId(r, tz)) + "</span></div></div>" +
      '<div class="body"><div class="vr"><div class="pill" style="background:' + colour + '">' + word + "</div>" +
      (r.grade ? '<div class="gr">GRADE ' + esc(r.grade) + "</div>" : "") +
      '<div class="ttl"><b>' + esc(r.title) + "</b><span>IMEI " + (esc(r.imei) || "—") + " &nbsp; · &nbsp; Serial " + (esc(r.serial) || "—") + "</span></div></div>" +
      (r.gradeMeaning ? '<p class="gm">' + esc(r.gradeMeaning) + "</p>" : "") +
      reasonsHTML(r) +
      pair([titled("Device", r.device), titled("Battery", r.battery)], [titled("Locks & network", r.locks), titled("Crash log & bench", r.health)]) +
      pair([titled("Apple's Parts & Service check", r.parts)], [titled("Fitted parts (serial numbers)", r.partSerials)]);
    if (tests.length) {
      out += "<h3>Tests on the phone — " + passed + " passed · " + failed + " failed" + (waiting ? " · " + waiting + " not done" : "") + "</h3>" +
        '<div class="tests">' + tests.map(testRow).join("") + "</div>";
    }
    if (cosmetic.length || r.cosmeticNote) {
      out += '<h3 style="margin-top:12pt">Cosmetic</h3><div class="cos">' + (r.cosmeticNote ? "<b>" + esc(r.cosmeticNote) + "</b>" : "") +
        esc(cosmetic.join("   ·   ")) + "</div>";
    }
    if (history.length > 1) {
      out += '<h3 style="margin-top:12pt">Every test on record for this phone — ' + history.length + "</h3>" +
        '<table class="hist"><thead><tr><th>Tested</th><th>Result</th><th>Grade</th><th>Technician</th><th>Saved because</th></tr></thead><tbody>' +
        history.map(function (h) {
          return "<tr" + (h.current ? ' class="me"' : "") + "><td>" + esc(h.when) + (h.current ? " — this report" : "") + "</td><td>" + (esc(h.result) || "—") +
            "</td><td>" + (esc(h.grade) || "—") + "</td><td>" + (esc(h.tech) || "—") + "</td><td>" + (esc(h.why) || "—") + "</td></tr>";
        }).join("") + "</tbody></table>";
    }
    out += '<div class="sign"><div class="qr">' + (env.qr && url ? env.qr(url) : "") + '</div><div class="st">' + esc(statement) + "</div>" +
      (r.serial ? '<div class="bc"><div class="bars">' + code128(r.serial) + '</div><div class="n">' + esc(r.serial) + "</div></div>" : "") + "</div>" +
      '<div class="foot"><div>' + esc(r.footer) + "</div><div>" + esc([r.versions, "YesAgain · Yes Check"].filter(Boolean).join(" · ")) + "</div></div>" +
      "</div></div>";
    return out;
  }

  // ------------------------------------------------------------------ an opened record
  var PILL = { PASS: "PASS", FAIL: "FAIL", REJECT: "REJECT", REVIEW: "REVIEW", INCOMPLETE: "INCOMPLETE" };
  var CHANGE_NAMES = { result: "Result", grade: "Grade", colour: "Colour", battery_health: "Battery health",
    battery_cycles: "Battery cycles", storage_total_gb: "Storage", ios: "iOS", failed_categories: "Failed tests",
    defects: "Cosmetic marks", notes: "Notes", model: "Model", imei: "IMEI" };
  function dl(rows, mono) {
    rows = arr(rows).filter(function (r) { return r && r.k; });
    if (!rows.length) return "";
    return '<dl class="kv">' + rows.map(function (r) {
      var c = r.tone === "ok" ? "var(--ok)" : (r.tone === "warn" ? "var(--watch)" : (r.tone === "bad" ? "var(--bad)" : ""));
      return "<dt>" + esc(r.k) + "</dt><dd" + (mono ? ' class="mono"' : "") + (c ? ' style="color:' + c + '"' : "") + ">" + (esc(r.v) || "—") + "</dd>";
    }).join("") + "</dl>";
  }
  function sec(title, body) { return body ? '<div class="sec">' + esc(title) + "</div>" + body : ""; }

  /**
   * What the record shows when it is opened: the same facts as its printed report, section by
   * section. `row` = the table row (flat()); its _raw must already hold the full snapshot.
   * env: { tested: text, history: html, loaded: false when the full record could not be fetched }
   */
  function detailHTML(row, env) {
    env = env || {};
    var raw = row._raw || {}, d = docs(raw), r = d.report;
    var res = row.result || "OTHER";
    var top = [
      "<dt>Result</dt><dd><span class=\"pill " + (PILL[res] || "OTHER") + "\">" + esc(row.result || "—") + "</span></dd>",
      "<dt>Grade</dt><dd>" + (row.grade ? '<span class="gr ' + esc(row.grade) + '">' + esc(row.grade) + "</span>" : '<span class="muted">not picked</span>') +
        (r.gradeMeaning && row.grade ? ' <span class="muted" style="font-weight:400">' + esc(r.gradeMeaning) + "</span>" : "") + "</dd>",
      env.tested ? "<dt>Tested</dt><dd>" + esc(env.tested) + (row.timezone ? ' <span class="muted">(' + esc(row.timezone) + ")</span>" : "") + "</dd>" : "",
      row.tech_disp ? "<dt>Technician</dt><dd>" + esc(row.tech_disp) + "</dd>" : "",
      row.warehouse ? "<dt>Warehouse</dt><dd>" + esc(row.warehouse) + "</dd>" : "",
      row.port ? "<dt>Bench port</dt><dd>PORT " + esc(row.port) + "</dd>" : "",
      row.test_number !== "" ? "<dt>Test of this phone</dt><dd>#" + esc(row.test_number) + "</dd>" : "",
      row.save_reason ? "<dt>Saved because</dt><dd>" + esc(row.save_reason) + "</dd>" : "",
      (row.probe_version || row.app_build) ? "<dt>Tested with</dt><dd>" + esc([row.probe_version ? "Probe " + row.probe_version : "",
        row.app_build ? "Yes Check Mobile build " + row.app_build : ""].filter(Boolean).join(" · ")) + "</dd>" : ""
    ].join("");
    var blockers = arr(r.blockers), warnings = arr(r.warnings), greens = arr(r.greens);
    var why;
    if (blockers.length || warnings.length) {
      why = '<div style="background:#f5f7fa;border-radius:8px;padding:8px 12px;margin-top:12px;font-size:13px">' +
        blockers.map(function (b) { return '<div style="color:var(--bad);font-weight:600;padding:2px 0">✗ ' + esc(b) + "</div>"; }).join("") +
        warnings.map(function (w) { return '<div style="color:var(--watch);font-weight:600;padding:2px 0">! ' + esc(w) + "</div>"; }).join("") + "</div>";
    } else if (row.result === "PASS") {
      why = '<div style="background:#f5f7fa;border-radius:8px;padding:8px 12px;margin-top:12px;font-size:13px;color:var(--ok);font-weight:600">✓ No faults found' +
        (greens.length ? " — " + greens.length + " checks clean" : "") + "</div>";
    } else why = "";
    var changes = raw.changes_from_previous && typeof raw.changes_from_previous === "object" ? raw.changes_from_previous : null;
    var changed = changes ? Object.keys(changes).map(function (k) {
      var c = changes[k] || {};
      return { k: CHANGE_NAMES[k] || k, v: (str(c.from) || "—") + "  →  " + (str(c.to) || "—") };
    }) : [];
    var device = [{ k: "Serial", v: row.serial }, { k: "IMEI", v: row.imei }].concat(arr(r.device));
    if (row.udid) device.push({ k: "UDID", v: row.udid });
    var tests = arr(r.tests);
    var passed = tests.filter(function (t) { return t.result === "pass"; }).length;
    var failed = tests.filter(function (t) { return t.result === "fail"; }).length;
    var waiting = tests.filter(function (t) { return !t.result; }).length;
    var testRows = tests.map(function (t) {
      var m = MARKS[str(t.result)] || ["–", "", "SKIPPED"];
      var c = t.result === "pass" ? "var(--ok)" : (t.result === "fail" ? "var(--bad)" : "var(--muted)");
      return "<tr><td style=\"white-space:normal\">" + esc(t.name) + "</td><td style=\"font-weight:700;color:" + c + "\">" + m[2] +
        "</td><td class=\"muted\" style=\"white-space:normal" + (t.result === "fail" ? ";color:var(--bad)" : "") + "\">" + esc(t.note) + "</td></tr>";
    }).join("");
    var cosmetic = arr(r.cosmetic);
    return '<dl class="kv">' + top + "</dl>" + why +
      sec("Changed since the previous test of this phone", dl(changed)) +
      sec("Device", dl(device)) +
      sec("Battery", dl(r.battery)) +
      sec("Locks & network", dl(r.locks)) +
      sec("Crash log & bench", dl(r.health)) +
      sec("Apple's Parts & Service check", dl(r.parts)) +
      sec("Fitted parts (serial numbers)", dl(r.partSerials, true)) +
      (testRows ? '<div class="sec">Tests on the phone — ' + passed + " passed · " + failed + " failed" + (waiting ? " · " + waiting + " not done" : "") +
        '</div><table style="font-size:12px;table-layout:auto"><thead><tr><th>Test</th><th>Result</th><th>What it measured</th></tr></thead><tbody>' + testRows + "</tbody></table>" : "") +
      ((cosmetic.length || r.cosmeticNote) ? '<div class="sec">Cosmetic</div><div style="font-size:13px">' + (r.cosmeticNote ? "<b>" + esc(r.cosmeticNote) + "</b> " : "") +
        esc(cosmetic.join(" · ")) + "</div>" : "") +
      (row.notes ? '<div style="font-size:13px;margin-top:8px"><b>Notes:</b> ' + esc(row.notes) + "</div>" : "") +
      (d.kept ? "" : '<div class="muted" style="font-size:12px;margin-top:10px">' + (env.loaded === false
        ? "The full record could not be loaded from the store just now — this is only what the list holds. Close it and open it again once the connection is back."
        : "This test was saved before the printouts were kept with it — the detail above is rebuilt from its saved fields.") + "</div>") +
      (env.history || "");
  }

  // ------------------------------------------------------------------ export
  var LOCK_WORDS = function (v, yes, no) { return v === true ? yes : (v === false ? no : ""); };
  var EXPORT_COLS = [
    ["Tested", function (r, env) { return env && env.tested ? env.tested(r) : r.tested_at; }],
    ["Serial", "serial"], ["IMEI", "imei"], ["Model", "model"], ["Model number", "model_number"],
    ["Storage", "storage_text"], ["Colour", "colour"], ["iOS", "ios"], ["YesAgain SKU", "sku"],
    ["Grade", "grade"], ["Result", "result"],
    ["Battery health %", function (r) { return r.batt_h == null ? "" : Math.min(100, r.batt_h); }],
    ["Battery cycles", function (r) { return r.batt_c == null ? "" : r.batt_c; }],
    ["iCloud lock", function (r) { return LOCK_WORDS(r.activation_locked, "LOCKED", "off"); }],
    ["MDM / managed", function (r) { return LOCK_WORDS(r.managed, "managed", "clean"); }],
    ["Carrier lock", function (r) { return r.carrier_words || "not checked"; }],
    ["Parts & Service", "parts"],
    ["Tests passed", "checks_passed"], ["Tests failed", "checks_failed"], ["Tests done", "checks_total"],
    ["Faults", "faults"], ["To check", "warnings"], ["Cosmetic marks", "cosmetic"],
    ["Technician", "technician"], ["Tech username", "technician_username"], ["Warehouse", "warehouse"],
    ["Department", "department"], ["Bench port", "port"], ["Saved because", "save_reason"],
    ["Probe", "probe_version"], ["Yes Check Mobile build", "app_build"], ["Test # of this phone", "test_number"],
    ["UDID", "udid"], ["Notes", "notes"]
  ];
  /** Header row + one row per record, for the Excel export. */
  function exportRows(rows, env) {
    var head = EXPORT_COLS.map(function (c) { return c[0]; });
    return [head].concat(arr(rows).map(function (r) {
      return EXPORT_COLS.map(function (c) {
        var v = typeof c[1] === "function" ? c[1](r, env) : r[c[1]];
        return v == null ? "" : v;
      });
    }));
  }

  var api = {
    COLS: COLS, SNAP_TEXT: SNAP_TEXT, SNAP_JSON: SNAP_JSON, listSelect: listSelect,
    flat: flat, verdict: verdict, carrier: carrier, partsSummary: partsSummary,
    storageText: storageText, storageGB: storageGB, faultTag: faultTag, testName: testName,
    docs: docs, record: record, reportId: reportId, certificateId: certificateId, longDate: longDate, localStamp: localStamp,
    code128: code128, code128Values: code128Values, cosmeticGroups: cosmeticGroups, cosmeticLines: cosmeticLines,
    LABEL_SIZES: LABEL_SIZES, labelSize: labelSize, labelCSS: labelCSS, labelHTML: labelHTML,
    certificateCSS: certificateCSS, certificateHTML: certificateHTML,
    reportCSS: reportCSS, reportHTML: reportHTML, detailHTML: detailHTML, exportRows: exportRows
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YCMobile = api;
})(typeof window !== "undefined" ? window : globalThis);
