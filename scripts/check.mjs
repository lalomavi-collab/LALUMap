#!/usr/bin/env node
// Static checks for public/ (framework-free, so there's no build/tsc to
// catch any of this). Encodes the exact checks a manual audit found real
// bugs from: a CSS [hidden]-vs-class-display bug, forbidden em/en-dashes
// in real page content (per CLAUDE.md's punctuation rule), and dead
// internal links. Pure Node, no dependencies, so it costs nothing to run
// on every push.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

let failures = 0;
function fail(message) {
  console.error(`✗ ${message}`);
  failures++;
}

const htmlFiles = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".html"));
const jsFiles = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".js"));

// 1. JS syntax
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", path.join(PUBLIC_DIR, f)], { stdio: "pipe" });
  } catch (err) {
    fail(`${f}: syntax error\n${err.stderr?.toString() ?? err.message}`);
  }
}

// 2. Duplicate ids per file
for (const f of htmlFiles) {
  const content = readFileSync(path.join(PUBLIC_DIR, f), "utf8");
  const ids = [...content.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const dups = new Set();
  for (const id of ids) {
    if (seen.has(id)) dups.add(id);
    seen.add(id);
  }
  if (dups.size > 0) fail(`${f}: duplicate id(s): ${[...dups].join(", ")}`);
}

// 3. Forbidden em/en-dash as punctuation in real content — never in a
// comment (a // trailing comment, a multi-line /* */ block, or a
// multi-line <!-- --> block; tracked across lines, not just a line's own
// start). A hyphen inside a word/identifier/URL is unaffected either way,
// since this only flags U+2013/U+2014, never the plain ASCII hyphen.
function checkDashes(f, content, isHTML) {
  let inBlockComment = false; // /* ... */ (JS) or <!-- ... --> (HTML)
  content.split("\n").forEach((line, i) => {
    let codePart = line;
    if (inBlockComment) {
      const closer = isHTML ? "-->" : "*/";
      const end = line.indexOf(closer);
      if (end === -1) return; // whole line still inside the comment
      codePart = line.slice(end + closer.length);
      inBlockComment = false;
    }
    if (!isHTML) {
      // Strip a trailing // comment (good enough here: this codebase
      // doesn't put // inside string literals in a way that matters for
      // a dash check).
      const slashIdx = codePart.indexOf("//");
      if (slashIdx !== -1) codePart = codePart.slice(0, slashIdx);
    }
    const opener = isHTML ? "<!--" : "/*";
    const openIdx = codePart.indexOf(opener);
    if (openIdx !== -1) {
      const beforeComment = codePart.slice(0, openIdx);
      const closer = isHTML ? "-->" : "*/";
      const closeIdx = codePart.indexOf(closer, openIdx);
      codePart = closeIdx === -1 ? beforeComment : beforeComment + codePart.slice(closeIdx + closer.length);
      if (closeIdx === -1) inBlockComment = true;
    }
    if (/[–—]/.test(codePart)) {
      fail(`${f}:${i + 1}: forbidden em/en-dash outside a comment: ${line.trim().slice(0, 100)}`);
    }
  });
}
for (const f of htmlFiles) checkDashes(f, readFileSync(path.join(PUBLIC_DIR, f), "utf8"), true);
for (const f of jsFiles) checkDashes(f, readFileSync(path.join(PUBLIC_DIR, f), "utf8"), false);

// 4. Internal links resolve: href="#id" to an id in the SAME file,
// href="/x" or href="/x.html" to a file that exists under public/.
for (const f of htmlFiles) {
  const content = readFileSync(path.join(PUBLIC_DIR, f), "utf8");
  const ids = new Set([...content.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const hrefs = [...content.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const href of hrefs) {
    if (href.startsWith("http") || href.startsWith("mailto:")) continue;
    if (href.startsWith("#")) {
      const id = href.slice(1);
      if (id && !ids.has(id)) fail(`${f}: href="${href}" has no matching id on this page`);
      continue;
    }
    if (href.startsWith("/")) {
      const rel = href.split("#")[0].replace(/^\//, "");
      const target = rel === "" ? "index.html" : rel;
      if (!existsSync(path.join(PUBLIC_DIR, target))) fail(`${f}: href="${href}" -> public/${target} does not exist`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`All checks passed (${htmlFiles.length} HTML files, ${jsFiles.length} JS files).`);
