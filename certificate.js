/* Full component test certificate — every test performed on a device, with its result.
 *
 * Distinct from the Certificate of Quality, which is a marketing A4 whose inspection block
 * is a fixed list of category names with a tick beside each regardless of what ran. This
 * one reports what the audit actually recorded, and is issued for any result: customer
 * service needs the component breakdown for a failed unit most of all.
 *
 * Honesty rule: a state is never upgraded. N/A stays N/A, untested stays untested, and a
 * record written before the checklist was uploaded says so rather than rendering blank.
 */
(function (root) {
  "use strict";

  // Same set, and the same order, as the unit report's proof-of-run table.
  var AUTOMATED = [
    ["thermal", "Thermal / CPU stress"], ["ram", "Memory (RAM)"], ["ssd", "Storage (SSD)"],
    ["battcell", "Battery cell balance"], ["battery", "Battery drain"],
    ["perf", "Performance benchmark"], ["memstress", "Memory under heat (beta, opt-in)"],
    ["thermalcycle", "Thermal-shock cycler (beta, opt-in)"]
  ];

  var STATES = { pass: 1, fail: 1, na: 1, untested: 1 };

  // The `details` key a test's proof of run is stored under. The drain test has its
  // own: `battery` holds the battery's HARDWARE facts (health, cycles), and while both
  // shared that key the facts overwrote the proof of run on upload — every record
  // written before the fix has facts there and no record of the run at all.
  function detailsKey(id) { return id === "battery" ? "battery_drain" : id; }

  // What one test's entry says. `recorded` separates "this app build never stored it"
  // from "the technician did not run it" — printing NOT RUN for the first blames a
  // person for a bug.
  function testRun(details, id) {
    var x = details && details[detailsKey(id)];
    if (!x || typeof x !== "object") {
      return { id: id, recorded: false, ran: false, duration: "\u2014", verdict: "", score: "", bands: [] };
    }
    var ran = x.ran === true || (!("ran" in x) && !!x.verdict);
    return { id: id, recorded: true, ran: ran, duration: ran ? fmtDuration(x.duration_s) : "\u2014",
             verdict: x.verdict || "", score: x.score == null ? "" : x.score,
             bands: Array.isArray(x.bands) ? x.bands : [] };
  }

  function fmtDuration(s) {
    if (s == null || s <= 0) return "—";
    s = Math.round(s);
    return s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s";
  }

  function readChecklist(snapshot) {
    var d = (snapshot && snapshot.details) || {};
    if (Array.isArray(d.checklist)) return d.checklist;
    // The flat column is a JSON string (the CSV/Excel carrier).
    var flat = (snapshot && snapshot.checklist) || d.checklist;
    if (typeof flat === "string") {
      try {
        var parsed = JSON.parse(flat);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) { /* an old or truncated value — treat as absent, never as empty */ }
    }
    return null;
  }

  function certificateRows(snapshot) {
    var details = (snapshot && snapshot.details) || {};
    var list = readChecklist(snapshot);

    var groups = [], byName = {}, counts = { pass: 0, fail: 0, na: 0, untested: 0, total: 0 };
    (list || []).forEach(function (it) {
      var name = it.group || "Other checks";
      if (!byName[name]) { byName[name] = { name: name, items: [] }; groups.push(byName[name]); }
      var state = STATES[it.state] ? it.state : "unknown";
      byName[name].items.push({ id: it.id, label: it.label || it.id, state: state });
      if (counts[state] !== undefined) counts[state]++;
      counts.total++;
    });

    var automated = [];
    AUTOMATED.forEach(function (pair) {
      var t = testRun(details, pair[0]);
      if (!t.recorded) return;                      // absent from this audit — say nothing
      t.name = pair[1];
      automated.push(t);
    });

    return { groups: groups, automated: automated, counts: counts, hasChecklist: !!(list && list.length) };
  }

  var api = { certificateRows: certificateRows, fmtDuration: fmtDuration, AUTOMATED: AUTOMATED,
              detailsKey: detailsKey, testRun: testRun };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YCCertificate = api;
})(typeof window !== "undefined" ? window : globalThis);
