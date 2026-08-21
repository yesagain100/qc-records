/* Minimal multi-sheet .xlsx writer.
 *
 * Deliberately dependency-free: this page is served from GitHub Pages and is used in
 * warehouses with unreliable internet, so pulling a spreadsheet library from a CDN would
 * make exports fail exactly when the network does. Stored (uncompressed) ZIP entries and
 * inline strings keep it to one readable file; correctness is pinned by tests/ that
 * generate a workbook and re-open it with a real spreadsheet reader.
 */
(function (root) {
  "use strict";

  var CRC = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    return new Uint8Array(Buffer.from(str, "utf8"));   // Node without TextEncoder
  }

  function esc(v) {
    return String(v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      // Excel rejects most C0 control characters outright.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  }

  /** Excel refuses []:*?/\ in a sheet name and caps it at 31 characters. */
  function sheetName(name) {
    var s = String(name == null ? "" : name).replace(/[\[\]:*?\/\\]/g, "").slice(0, 31);
    return s.trim() || "Sheet";
  }

  function sheetXml(rows) {
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r] || [];
      out.push('<row r="' + (r + 1) + '">');
      for (var c = 0; c < row.length; c++) {
        var v = row[c];
        if (v === null || v === undefined || v === "") continue;   // a blank cell is simply absent
        var ref = colRef(c) + (r + 1);
        if (typeof v === "number" && isFinite(v)) {
          out.push('<c r="' + ref + '"><v>' + v + "</v></c>");
        } else {
          out.push('<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">'
                   + esc(v) + "</t></is></c>");
        }
      }
      out.push("</row>");
    }
    out.push("</sheetData></worksheet>");
    return out.join("");
  }

  function colRef(i) {
    var s = "";
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  function u16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
  function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

  /** Stored-only ZIP. No deflate: a lot export is a few hundred KB of XML and the
   *  saving is not worth hand-rolling a compressor whose bugs would be silent. */
  function zip(files) {
    var local = [], central = [], offset = 0;
    files.forEach(function (f) {
      var data = utf8(f.content), name = utf8(f.name), sum = crc32(data);
      var hdr = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
                          u32(sum), u32(data.length), u32(data.length),
                          u16(name.length), u16(0));
      local.push(new Uint8Array(hdr), name, data);
      central.push(new Uint8Array([].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(sum), u32(data.length), u32(data.length),
        u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += hdr.length + name.length + data.length;
    });
    var cenSize = central.reduce(function (n, p) { return n + p.length; }, 0);
    var end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0),
      u16(files.length), u16(files.length), u32(cenSize), u32(offset), u16(0)));
    var parts = local.concat(central, [end]);
    var total = parts.reduce(function (n, p) { return n + p.length; }, 0);
    var out = new Uint8Array(total), at = 0;
    parts.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  /** sheets: [{name, rows: [[cell, ...], ...]}] — the first row is the header. */
  function buildXlsx(sheets) {
    if (!sheets || !sheets.length) throw new Error("buildXlsx needs at least one sheet");
    sheets.forEach(function (s) {
      if (!s || !s.name) throw new Error("every sheet needs a name");
    });
    var names = sheets.map(function (s) { return sheetName(s.name); });
    var files = [
      { name: "[Content_Types].xml",
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          + '<Default Extension="xml" ContentType="application/xml"/>'
          + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          + names.map(function (_, i) {
              return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" '
                   + 'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
            }).join("")
          + "</Types>" },
      { name: "_rels/.rels",
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
          + "</Relationships>" },
      { name: "xl/workbook.xml",
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
          + names.map(function (n, i) {
              return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
            }).join("")
          + "</sheets></workbook>" },
      { name: "xl/_rels/workbook.xml.rels",
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + names.map(function (_, i) {
              return '<Relationship Id="rId' + (i + 1) + '" '
                   + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
                   + 'Target="worksheets/sheet' + (i + 1) + '.xml"/>';
            }).join("")
          + "</Relationships>" }
    ];
    sheets.forEach(function (s, i) {
      files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", content: sheetXml(s.rows || []) });
    });
    return zip(files);
  }

  /** Hand the workbook to the browser as a download. */
  function downloadXlsx(sheets, filename) {
    var blob = new Blob([buildXlsx(sheets)],
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  var api = { buildXlsx: buildXlsx, downloadXlsx: downloadXlsx, _sheetName: sheetName, _esc: esc };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YCXlsx = api;
})(typeof window !== "undefined" ? window : globalThis);
