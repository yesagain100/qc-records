/* Lot report: every unit in a lot, not just the defective ones.
 *
 * A lot is the union of two sources — the serials the supplier declared on the uploaded
 * intake sheet, and the units actually tested against that lot. Neither alone is the lot:
 * a sheet serial that never arrived still has to show as NOT TESTED, and a unit tested
 * under the lot but absent from the sheet still has to appear.
 */
(function (root) {
  "use strict";

  /** Same rule as the engine's _norm_serial, so both sides agree on identity. */
  function normSerial(s) {
    return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function normGroup(s) {
    return String(s == null ? "" : s).trim().toLowerCase();
  }

  /** Supplier's claimed grade vs what we graded it. Blank on either side means no claim. */
  function gradeMatch(supplier, tested) {
    var a = String(supplier || "").trim().toUpperCase();
    var b = String(tested || "").trim().toUpperCase();
    if (!a || !b) return "";
    return a === b ? "match" : "supplier " + a + " → " + b;
  }

  function isDefectiveResult(r) {
    var v = String(r || "").toUpperCase();
    return v === "FAIL" || v.indexOf("REJECT") === 0;
  }

  function latest(a, b) {
    return new Date(b.tested_at || 0) > new Date(a.tested_at || 0) ? b : a;
  }

  /**
   * opts: {units, supplierRows, audits, lotId, goodsInGroups}
   *  - units:        latest tested record per serial, as the records table shapes them
   *  - supplierRows: lot_serials rows (serial + supplier_* claims)
   *  - audits:       every audit, used to find the Goods In pass for a unit
   *  - goodsInGroups: department ids that count as Goods In (default ["goods_in"])
   */
  function lotRows(opts) {
    var lotId = opts.lotId;
    var goodsIn = (opts.goodsInGroups || ["goods_in"]).map(normGroup);

    var bySerial = {};
    (opts.units || []).forEach(function (u) {
      if (u.lot_id !== lotId) return;
      var k = normSerial(u.serial);
      if (k) bySerial[k] = u;
    });

    var claims = {};
    (opts.supplierRows || []).forEach(function (s) {
      if (s.lot_id && s.lot_id !== lotId) return;
      var k = normSerial(s.serial);
      if (k) claims[k] = s;
    });

    // Latest Goods In audit per serial. Blank until the department is really recorded —
    // never fall back to "the first test", which would mislabel every historic record.
    var goodsInBySerial = {};
    (opts.audits || []).forEach(function (a) {
      if (goodsIn.indexOf(normGroup(a.department)) < 0) return;
      var k = normSerial(a.serial);
      if (!k) return;
      goodsInBySerial[k] = goodsInBySerial[k] ? latest(goodsInBySerial[k], a) : a;
    });

    var keys = {};
    Object.keys(bySerial).forEach(function (k) { keys[k] = true; });
    Object.keys(claims).forEach(function (k) { keys[k] = true; });

    return Object.keys(keys).sort().map(function (k) {
      var u = bySerial[k] || null, c = claims[k] || {}, g = goodsInBySerial[k];
      var overall = u ? (u.grade || "") : "";
      return {
        serial: u ? u.serial : (c.serial || k),
        tested: !!u,
        model: u ? (u.model || "") : (c.supplier_model || ""),
        supplierGrade: c.supplier_grade || "",
        goodsInGrade: g ? (g.grade || "") : "",
        screenGrade: u ? (u.display_grade || "") : "",
        bodyGrade: u ? (u.body_grade || "") : "",
        overallGrade: overall,
        gradeMatch: gradeMatch(c.supplier_grade, overall),
        result: u ? (u.result || "") : "NOT TESTED",
        battery: u ? u.batt_h : null,
        cycles: u ? u.batt_c : null,
        faults: u ? (u.faults || "") : "",
        technician: u ? (u.tech_disp || u.technician || "") : "",
        warehouse: u ? (u.warehouse || "") : "",
        department: u ? (u.department || "") : "",
        testedAt: u ? (u.tested_at || "") : "",
        sku: u ? (u.sku || "") : "",
        memory: u ? u.memory : (c.supplier_ram || ""),
        storage: u ? u.storage : (c.supplier_ssd || ""),
        po: u ? (u.po || "") : "",
        supplier: u ? (u.supplier || "") : (c.supplier || ""),
        _raw: u
      };
    });
  }

  function lotSummary(rows) {
    var tested = rows.filter(function (r) { return r.tested; });
    var defective = tested.filter(function (r) { return isDefectiveResult(r.result); });
    var grades = {}, faults = {};
    tested.forEach(function (r) {
      if (r.overallGrade) grades[r.overallGrade] = (grades[r.overallGrade] || 0) + 1;
      String(r.faults || "").split(/\s*[;,]\s*/).forEach(function (f) {
        if (f) faults[f] = (faults[f] || 0) + 1;
      });
    });
    return {
      total: rows.length,
      tested: tested.length,
      notTested: rows.length - tested.length,
      defective: defective.length,
      // Over TESTED units: a lot half-way through inspection would otherwise look clean.
      defectRate: tested.length ? Math.round((defective.length / tested.length) * 1000) / 10 : 0,
      grades: grades,
      faults: faults
    };
  }

  /** The Details tab: one row per unit in the lot, header first. */
  function lotDetailSheet(rows, lotId, fmtDate) {
    var fmt = fmtDate || function (d) { return d || ""; };
    var out = [["Serial", "Model", "SKU", "Supplier grade", "Goods In grade", "Screen grade",
                "Body grade", "Overall grade", "Grade check", "Result", "Battery %", "Cycles",
                "RAM", "Storage", "Faults", "Technician", "Warehouse", "Group", "Tested",
                "Lot", "PO", "Supplier"]];
    rows.forEach(function (r) {
      out.push([r.serial, r.model, r.sku, r.supplierGrade, r.goodsInGrade, r.screenGrade,
                r.bodyGrade, r.overallGrade, r.gradeMatch, r.result,
                r.battery == null ? null : Math.min(100, r.battery), r.cycles,
                r.memory, r.storage, r.faults, r.technician, r.warehouse, r.department,
                r.testedAt ? fmt(r.testedAt) : "", lotId, r.po, r.supplier]);
    });
    return out;
  }

  /** The Summary tab: the lot's report figures, then grade and fault breakdowns. */
  function lotSummarySheet(rows, lotId, generatedAt) {
    var sum = lotSummary(rows);
    var uniq = function (k) {
      var seen = {};
      rows.forEach(function (r) { if (r[k]) seen[r[k]] = true; });
      return Object.keys(seen).join(", ");
    };
    var out = [["Metric", "Value"],
      ["Lot", lotId],
      ["Supplier", uniq("supplier")],
      ["PO", uniq("po")],
      ["Units in lot", sum.total],
      ["Tested", sum.tested],
      ["Not tested", sum.notTested],
      ["Fail / reject", sum.defective],
      ["Defect rate (% of tested)", sum.defectRate],
      ["Report generated", generatedAt || ""],
      [], ["Grade", "Units"]];
    Object.keys(sum.grades).sort().forEach(function (g) { out.push([g, sum.grades[g]]); });
    out.push([], ["Fault", "Units"]);
    Object.keys(sum.faults).sort(function (a, b) { return sum.faults[b] - sum.faults[a]; })
      .forEach(function (f) { out.push([f, sum.faults[f]]); });
    return out;
  }

  var api = { lotRows: lotRows, lotSummary: lotSummary, normSerial: normSerial,
              lotDetailSheet: lotDetailSheet, lotSummarySheet: lotSummarySheet,
              gradeMatch: gradeMatch, isDefectiveResult: isDefectiveResult };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YCLotReport = api;
})(typeof window !== "undefined" ? window : globalThis);
