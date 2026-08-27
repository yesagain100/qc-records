#!/bin/bash
# Build a deployable copy of the portal.
#
# index.html loads lotreport.js / xlsx.js / certificate.js as siblings, which works when
# the whole directory is served (GitHub Pages). A host where only one file gets uploaded
# would leave those scripts 404ing and the lot report dead, so dist/index.html has them
# inlined — one self-contained file plus the two logos.
set -e
cd "$(dirname "$0")"
mkdir -p dist
python3 - <<'PY'
import re, sys
html = open("index.html", encoding="utf-8").read()
for name in ("lotreport.js", "xlsx.js", "certificate.js"):
    js = open(name, encoding="utf-8").read()
    if "</script" in js.lower():
        sys.exit("refusing to inline %s: it contains a closing script tag" % name)
    tag = '<script src="%s"></script>' % name
    if tag not in html:
        sys.exit("missing %s in index.html" % tag)
    html = html.replace(tag, "<script>\n/* inlined from %s */\n%s\n</script>" % (name, js), 1)
open("dist/index.html", "w", encoding="utf-8").write(html)
print("dist/index.html", len(html), "bytes")
PY
cp logo_orange.png logo_white.png dist/
echo "dist/ ready — upload its contents (index.html + the two logos)."
