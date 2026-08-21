const { test } = require("node:test");
const assert = require("node:assert");
const { buildXlsx, _sheetName, _esc } = require("../xlsx.js");

test("emits a ZIP container", () => {
  const b = buildXlsx([{ name: "S", rows: [["a"]] }]);
  assert.equal(b[0], 0x50, "starts with P");
  assert.equal(b[1], 0x4b, "starts with K");
  assert.ok(b.length > 400, "has real content");
});

test("rejects an empty sheet list", () => {
  assert.throws(() => buildXlsx([]), /at least one sheet/i);
});

test("rejects a sheet with no name", () => {
  assert.throws(() => buildXlsx([{ rows: [["a"]] }]), /name/i);
});

test("a sheet with no rows is allowed (an empty lot still exports)", () => {
  const b = buildXlsx([{ name: "Empty", rows: [] }]);
  assert.ok(b.length > 0);
});

test("sheet names are trimmed to Excel's 31-character limit", () => {
  assert.equal(_sheetName("x".repeat(40)).length, 31);
});

test("sheet names drop the characters Excel refuses", () => {
  assert.equal(_sheetName("Lot[1]:a/b\\c*d?e"), "Lot1abcde");
});

test("a sheet name that is only illegal characters still yields something", () => {
  assert.ok(_sheetName("[]:*?/\\").length > 0);
});

test("XML special characters are escaped, not dropped", () => {
  assert.equal(_esc('a & b < c > d'), "a &amp; b &lt; c &gt; d");
});

test("Arabic text survives escaping untouched", () => {
  assert.equal(_esc("شاشة مكسورة"), "شاشة مكسورة");
});

test("null and undefined cells become blanks, not the string 'null'", () => {
  const b = buildXlsx([{ name: "S", rows: [["a", null, undefined, ""]] }]);
  const xml = Buffer.from(b).toString("latin1");
  assert.ok(!xml.includes("null"), "no literal null in the sheet XML");
});

test("numbers are written as numbers, not text", () => {
  const b = buildXlsx([{ name: "S", rows: [[42]] }]);
  const xml = Buffer.from(b).toString("latin1");
  assert.ok(xml.includes("<v>42</v>"), "numeric cell uses <v>");
});
