// Lift a named function straight out of index.html so a unit test exercises the code
// the browser actually runs — not a copy that can quietly drift from the page.
const assert = require("node:assert");

function extractFn(src, name) {
  let start = src.indexOf("function " + name + "(");
  assert.ok(start > -1, name + " not found in index.html");
  // Keep the `async` keyword: without it the lifted copy can't await.
  if (src.slice(start - 6, start) === "async ") start -= 6;
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

module.exports = { extractFn };

// Lift a top-level `const NAME = ...;` (arrays span lines) out of the page, so a test
// can run a function that leans on it without copying the value into the test.
function extractConst(src, name) {
  const re = new RegExp("^const " + name + "\\s*=", "m");
  const m = re.exec(src);
  assert.ok(m, name + " not found in index.html");
  let depth = 0;
  for (let j = m.index; j < src.length; j++) {
    const c = src[j];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error("unterminated const " + name);
}

module.exports.extractConst = extractConst;
