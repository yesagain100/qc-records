const { test } = require("node:test");
const assert = require("node:assert");
const { certificateRows, fmtDuration } = require("../certificate.js");

test("checklist items are grouped, in first-seen order", () => {
  const r = certificateRows({ details: { checklist: [
    { id: "wifi", label: "Wi-Fi", group: "Wireless", state: "pass" },
    { id: "kbd", label: "Keyboard", group: "Input", state: "pass" },
    { id: "bt", label: "Bluetooth", group: "Wireless", state: "fail" }
  ] } });
  assert.deepEqual(r.groups.map(g => g.name), ["Wireless", "Input"]);
  assert.equal(r.groups[0].items.length, 2);
});

test("every state survives verbatim — nothing becomes a silent pass", () => {
  const r = certificateRows({ details: { checklist: [
    { id: "a", label: "A", group: "G", state: "pass" },
    { id: "b", label: "B", group: "G", state: "fail" },
    { id: "c", label: "C", group: "G", state: "na" },
    { id: "d", label: "D", group: "G", state: "untested" }
  ] } });
  assert.deepEqual(r.groups[0].items.map(i => i.state), ["pass", "fail", "na", "untested"]);
});

test("an unknown state is not coerced to pass", () => {
  const r = certificateRows({ details: { checklist: [
    { id: "a", label: "A", group: "G", state: "weird" }
  ] } });
  assert.equal(r.groups[0].items[0].state, "unknown");
});

test("an item with no group still appears", () => {
  const r = certificateRows({ details: { checklist: [{ id: "a", label: "A", state: "pass" }] } });
  assert.equal(r.groups.length, 1);
  assert.ok(r.groups[0].name);
});

test("a record from before the checklist shipped is flagged, not faked", () => {
  const r = certificateRows({ details: { thermal: { ran: true, verdict: "PASS" } } });
  assert.equal(r.hasChecklist, false);
  assert.deepEqual(r.groups, []);
  assert.ok(r.automated.length, "the automated block still renders");
});

test("no details at all is safe", () => {
  const r = certificateRows({});
  assert.equal(r.hasChecklist, false);
  assert.deepEqual(r.groups, []);
  assert.deepEqual(r.automated, []);
});

test("a null snapshot is safe", () => {
  const r = certificateRows(null);
  assert.equal(r.hasChecklist, false);
});

test("automated tests report what actually ran", () => {
  const r = certificateRows({ details: {
    thermal: { ran: true, duration_s: 90, verdict: "PASS" },
    ram: { ran: false },
    ssd: { ran: true, duration_s: 45, verdict: "WARN" }
  } });
  const by = Object.fromEntries(r.automated.map(a => [a.id, a]));
  assert.equal(by.thermal.ran, true);
  assert.equal(by.thermal.duration, "1m 30s");
  assert.equal(by.ram.ran, false);
  assert.equal(by.ram.duration, "—");
  assert.equal(by.ssd.verdict, "WARN");
});

test("an automated test absent from the snapshot is omitted, not shown as failed", () => {
  const r = certificateRows({ details: { thermal: { ran: true, verdict: "PASS" } } });
  assert.deepEqual(r.automated.map(a => a.id), ["thermal"]);
});

test("durations format the way the unit report does", () => {
  assert.equal(fmtDuration(0), "—");
  assert.equal(fmtDuration(null), "—");
  assert.equal(fmtDuration(45), "45s");
  assert.equal(fmtDuration(60), "1m 0s");
  assert.equal(fmtDuration(3661), "61m 1s");
});

test("measurement bands ride along with each automated test", () => {
  const r = certificateRows({ details: { thermal: { ran: true, verdict: "PASS",
    bands: [{ label: "Peak CPU", value: "97", unit: "°C", status: "warn" }] } } });
  assert.equal(r.automated[0].bands.length, 1);
  assert.equal(r.automated[0].bands[0].label, "Peak CPU");
});

test("counts summarise what the certificate is asserting", () => {
  const r = certificateRows({ details: { checklist: [
    { id: "a", label: "A", group: "G", state: "pass" },
    { id: "b", label: "B", group: "G", state: "pass" },
    { id: "c", label: "C", group: "G", state: "fail" },
    { id: "d", label: "D", group: "G", state: "na" },
    { id: "e", label: "E", group: "G", state: "untested" }
  ] } });
  assert.equal(r.counts.pass, 2);
  assert.equal(r.counts.fail, 1);
  assert.equal(r.counts.na, 1);
  assert.equal(r.counts.untested, 1);
  assert.equal(r.counts.total, 5);
});

test("a checklist delivered as a JSON string is parsed", () => {
  const r = certificateRows({ checklist: '[{"id":"a","label":"A","group":"G","state":"na"}]' });
  assert.equal(r.hasChecklist, true);
  assert.equal(r.groups[0].items[0].state, "na");
});

test("a malformed checklist string does not throw", () => {
  const r = certificateRows({ checklist: "{not json" });
  assert.equal(r.hasChecklist, false);
});
