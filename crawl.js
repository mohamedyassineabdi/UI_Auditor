const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;
const PptxGenJS = require("pptxgenjs");

const START_URL = process.argv[2];
const modeArg = process.argv.slice(3).find((arg) => arg.startsWith("--mode="));
const SCAN_MODE = modeArg?.split("=")[1] === "fast" ? "fast" : "debug";

if (!START_URL) {
  console.error("Usage: node crawl.js https://example.com [--mode=debug|fast]");
  process.exit(1);
}

// Crawl limits
const MAX_PAGES = 50;
const MAX_DEPTH = 4;

// Button testing limits
const MAX_CLICKS_PER_PAGE = 4;

// Accessibility report size limits
const MAX_AXE_NODES_PER_VIOLATION = 10;
const MAX_AXE_HTML_CHARS = 500;

// Speed / visibility
const SHOW_BROWSER = SCAN_MODE === "debug";
const SLOW_MO_MS = 0;
const NAV_TIMEOUT_MS = 15000;
const CLICK_TIMEOUT_MS = 6000;
const POST_CLICK_WAIT_MS = 250;

// Screenshot policy: one per page (viewport-only)
const TAKE_ONE_SCREENSHOT_PER_PAGE = true;
const PAGE_SCREENSHOT_FULLPAGE = false;

// Live preview image (for UI backup preview)
const LIVE_PREVIEW_ENABLED = SCAN_MODE === "debug";
const LIVE_PREVIEW_FULLPAGE = false;

// Safety deny-list
const CLICK_DENY_WORDS = [
  "delete",
  "remove",
  "logout",
  "log out",
  "sign out",
  "unsubscribe",
  "pay",
  "purchase",
  "checkout",
  "order",
  "confirm",
  "submit",
  "cancel",
  "billing",
  "settings",
];

const DROP_QUERY_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "ref",
  "ref_src",
]);

const ROOT_PATH_ALIASES = new Set([
  "/index",
  "/index.html",
  "/index.htm",
  "/index.php",
  "/default.aspx",
  "/home",
  "/home/index",
  "/home/index.html",
]);

const LOOP_QUERY_PARAMS = new Set([
  "session",
  "sid",
  "phpsessid",
  "token",
  "auth",
  "replytocom",
  "share",
  "print",
]);

const LOOP_PATH_PATTERNS = [
  /\/(wp-admin|wp-login|logout|signout|sign-out)\b/i,
  /\/(cart|checkout|billing|order|payment)\b/i,
  /\/(calendar|events|archive)\b/i,
];

function safeFilename(text) {
  return String(text)
    .replace(/https?:\/\//, "")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 180);
}

function safeFolderName(text) {
  return String(text).replace(/[^\w.-]+/g, "_");
}

function looksDangerous(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return CLICK_DENY_WORDS.some((w) => t.includes(w));
}

function impactToSeverity(impact) {
  if (impact === "critical" || impact === "serious") return "high";
  if (impact === "moderate") return "medium";
  return "low";
}

function normalizeUrl(inputUrl, { dropWww = true, forceProtocol = null } = {}) {
  try {
    const u = new URL(inputUrl);

    if (forceProtocol) u.protocol = forceProtocol;
    u.hostname = u.hostname.toLowerCase();
    if (dropWww && u.hostname.startsWith("www.")) u.hostname = u.hostname.slice(4);

    if (
      (u.protocol === "https:" && u.port === "443") ||
      (u.protocol === "http:" && u.port === "80")
    ) {
      u.port = "";
    }

    u.hash = "";

    for (const key of [...u.searchParams.keys()]) {
      if (DROP_QUERY_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.searchParams.sort();

    let pathname = u.pathname || "/";
    pathname = pathname.replace(/\/{2,}/g, "/");
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
    if (!pathname) pathname = "/";

    const lowerPath = pathname.toLowerCase();
    if (ROOT_PATH_ALIASES.has(lowerPath)) pathname = "/";

    u.pathname = pathname;
    return u.toString();
  } catch {
    return null;
  }
}

function sameDomain(urlA, urlB) {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    const ah = a.hostname.toLowerCase().replace(/^www\./, "");
    const bh = b.hostname.toLowerCase().replace(/^www\./, "");
    return ah === bh;
  } catch {
    return false;
  }
}

function shouldSkipLink(rawUrl) {
  if (!rawUrl) return true;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(rawUrl)) return true;

  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return true;
    if (u.href.length > 260) return true;

    const pathname = (u.pathname || "/").toLowerCase();
    const parts = pathname.split("/").filter(Boolean);

    if (parts.length > 12) return true;
    if (LOOP_PATH_PATTERNS.some((r) => r.test(pathname))) return true;

    for (const [key, val] of u.searchParams.entries()) {
      if (LOOP_QUERY_PARAMS.has(key.toLowerCase())) return true;
      if (String(val || "").length > 120) return true;
    }

    return false;
  } catch {
    return true;
  }
}

async function dismissCookieBanners(page) {
  try {
    const clicked = await page.evaluate(() => {
      const roots = Array.from(
        document.querySelectorAll(
          [
            '[id*="cookie" i]',
            '[class*="cookie" i]',
            '[id*="consent" i]',
            '[class*="consent" i]',
            '[id*="gdpr" i]',
            '[class*="gdpr" i]',
            '[aria-label*="cookie" i]',
            '[aria-label*="consent" i]',
            '[role="dialog"]',
          ].join(",")
        )
      );

      const actionRe = /(accept|agree|allow|ok|got it|close|reject|decline|dismiss)/i;
      const contextRe = /(cookie|consent|privacy|gdpr)/i;
      const buttonSel = 'button, [role="button"], a, input[type="button"], input[type="submit"]';

      const getText = (el) =>
        (
          el.innerText ||
          el.textContent ||
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.value ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ");

      for (const root of roots) {
        if (!root || !root.isConnected) continue;
        const rootText = getText(root);
        const rootMeta = `${root.id || ""} ${root.className || ""} ${rootText}`.toLowerCase();
        if (!contextRe.test(rootMeta)) continue;

        const candidates = Array.from(root.querySelectorAll(buttonSel));
        for (const candidate of candidates) {
          const text = getText(candidate);
          if (!text || !actionRe.test(text)) continue;
          candidate.click();
          return true;
        }
      }

      return false;
    });

    if (clicked) await page.waitForTimeout(150);
    return clicked;
  } catch {
    return false;
  }
}

function buildReportSummary(report) {
  const recurringByRule = new Map();
  const pageSummaries = [];

  for (const page of report.pages || []) {
    const counts = { high: 0, medium: 0, low: 0 };
    const a11yIssues = (page.issues || []).filter((i) =>
      String(i.ruleId || "").startsWith("a11y:")
    );

    for (const issue of a11yIssues) {
      const sev = issue.severity || "low";
      if (!counts[sev]) counts[sev] = 0;
      counts[sev] += 1;

      const key = issue.ruleId || "a11y:unknown";
      if (!recurringByRule.has(key)) {
        recurringByRule.set(key, {
          ruleId: key,
          count: 0,
          pages: new Set(),
          sampleMessage: issue.message || "",
          helpUrl: issue.evidence?.helpUrl || "",
          severityCounts: { high: 0, medium: 0, low: 0 },
        });
      }

      const item = recurringByRule.get(key);
      item.count += 1;
      item.pages.add(page.url);
      item.severityCounts[sev] = (item.severityCounts[sev] || 0) + 1;
      if (!item.sampleMessage && issue.message) item.sampleMessage = issue.message;
      if (!item.helpUrl && issue.evidence?.helpUrl) item.helpUrl = issue.evidence.helpUrl;
    }

    pageSummaries.push({
      url: page.url,
      title: page.title || "",
      depth: page.depth,
      issueCount: a11yIssues.length,
      high: counts.high || 0,
      medium: counts.medium || 0,
      low: counts.low || 0,
      screenshot: page.screenshot || null,
    });
  }

  const topRecurringIssues = [...recurringByRule.values()]
    .map((entry) => ({
      ruleId: entry.ruleId,
      count: entry.count,
      pagesAffected: entry.pages.size,
      sampleMessage: entry.sampleMessage,
      helpUrl: entry.helpUrl,
      severityCounts: entry.severityCounts,
    }))
    .sort((a, b) => b.count - a.count || b.pagesAffected - a.pagesAffected || a.ruleId.localeCompare(b.ruleId))
    .slice(0, 15);

  pageSummaries.sort((a, b) => b.issueCount - a.issueCount || a.url.localeCompare(b.url));

  return {
    scannedPages: pageSummaries.length,
    pageSummaries,
    topRecurringIssues,
  };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toPosixPath(p) {
  return String(p).replace(/\\/g, "/");
}

function relativeFromOutput(outputDir, targetPath) {
  if (!outputDir || !targetPath) return null;
  return toPosixPath(path.relative(outputDir, targetPath));
}

function compactText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value, maxLen = 180) {
  const text = compactText(value);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 3))}...`;
}

function buildA11yObservations(report) {
  const observations = [];

  for (const p of report.pages || []) {
    for (const issue of p.issues || []) {
      if (!String(issue.ruleId || "").startsWith("a11y:")) continue;
      observations.push({
        severity: issue.severity || "low",
        ruleId: issue.ruleId,
        message: issue.message || "",
        url: issue.evidence?.url || p.url,
        screenshot: issue.evidence?.screenshot || p.screenshot,
        helpUrl: issue.evidence?.helpUrl || "",
        sampleTarget: issue.evidence?.sampleTarget || "",
        pageTitle: p.title || "",
      });
    }
  }

  const severityOrder = { high: 0, medium: 1, low: 2 };
  observations.sort((a, b) => {
    const bySeverity = (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9);
    if (bySeverity !== 0) return bySeverity;
    const byRule = String(a.ruleId || "").localeCompare(String(b.ruleId || ""));
    if (byRule !== 0) return byRule;
    return String(a.url || "").localeCompare(String(b.url || ""));
  });

  return observations.map((obs, idx) => ({ ...obs, observationNumber: idx + 1 }));
}

function generateHtmlReport(report) {
  const allIssues = buildA11yObservations(report);

  const grouped = {
    high: allIssues.filter((x) => x.severity === "high"),
    medium: allIssues.filter((x) => x.severity === "medium"),
    low: allIssues.filter((x) => x.severity === "low"),
  };

  const summary = report.summary || buildReportSummary(report);
  const total = allIssues.length;
  const scannedPages = report.pages?.length || 0;

  function renderIssue(issue) {
    const relShot = relativeFromOutput(report.outputDir, issue.screenshot);
    const screenshotLink = relShot
      ? `<a href="${escapeHtml(relShot)}" target="_blank" rel="noopener">Screenshot</a>`
      : `<span class="muted">No screenshot</span>`;

    const helpLink = issue.helpUrl
      ? `<a href="${escapeHtml(issue.helpUrl)}" target="_blank" rel="noopener">Axe help</a>`
      : `<span class="muted">No help link</span>`;

    const target = escapeHtml(
      Array.isArray(issue.sampleTarget) ? issue.sampleTarget.join(", ") : issue.sampleTarget
    );

    return `
      <div class="issue">
        <div class="issue-head">
          <span class="badge ${issue.severity}">${issue.severity.toUpperCase()}</span>
          <span class="rule">${escapeHtml(issue.ruleId)}</span>
        </div>
        <div class="issue-msg">${escapeHtml(issue.message)}</div>
        <div class="meta">
          <div><span class="label">Page:</span> <a href="${escapeHtml(issue.url)}" target="_blank" rel="noopener">${escapeHtml(issue.url)}</a></div>
          ${issue.pageTitle ? `<div><span class="label">Title:</span> ${escapeHtml(issue.pageTitle)}</div>` : ""}
          ${target ? `<div><span class="label">Sample target:</span> <code>${target}</code></div>` : ""}
          <div class="links">${screenshotLink} | ${helpLink}</div>
        </div>
      </div>
    `;
  }

  function renderSection(name, issues) {
    return `
      <section>
        <h2>${name} <span class="count">(${issues.length})</span></h2>
        ${issues.length ? issues.map(renderIssue).join("\n") : `<p class="muted">No issues.</p>`}
      </section>
    `;
  }

  function renderTopRecurring() {
    const rows = (summary.topRecurringIssues || [])
      .map((item) => {
        const help = item.helpUrl
          ? `<a href="${escapeHtml(item.helpUrl)}" target="_blank" rel="noopener">Help</a>`
          : `<span class="muted">n/a</span>`;
        return `
          <tr>
            <td><code>${escapeHtml(item.ruleId)}</code></td>
            <td>${item.count}</td>
            <td>${item.pagesAffected}</td>
            <td>${item.severityCounts.high || 0}/${item.severityCounts.medium || 0}/${item.severityCounts.low || 0}</td>
            <td>${help}</td>
          </tr>
        `;
      })
      .join("\n");

    return `
      <section>
        <h2>Top recurring issues</h2>
        ${
          rows
            ? `<table>
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Total</th>
                    <th>Pages</th>
                    <th>H/M/L</th>
                    <th>Help</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>`
            : `<p class="muted">No recurring issues.</p>`
        }
      </section>
    `;
  }

  function renderPagesList() {
    const rows = (summary.pageSummaries || [])
      .map((p) => {
        const relShot = relativeFromOutput(report.outputDir, p.screenshot);
        const shot = relShot
          ? `<a href="${escapeHtml(relShot)}" target="_blank" rel="noopener">Screenshot</a>`
          : `<span class="muted">No screenshot</span>`;
        return `
          <tr>
            <td><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.url)}</a></td>
            <td>${escapeHtml(p.title || "-")}</td>
            <td>${p.depth ?? "-"}</td>
            <td>${p.issueCount}</td>
            <td>${p.high}/${p.medium}/${p.low}</td>
            <td>${shot}</td>
          </tr>
        `;
      })
      .join("\n");

    return `
      <section>
        <h2>Pages scanned</h2>
        ${
          rows
            ? `<table>
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>Title</th>
                    <th>Depth</th>
                    <th>A11y issues</th>
                    <th>H/M/L</th>
                    <th>Screenshot</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>`
            : `<p class="muted">No pages scanned.</p>`
        }
      </section>
    `;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>A11y Audit Report - ${escapeHtml(report.domain || "")}</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; color: #111; }
    header { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
    section { margin-top: 20px; }
    h1 { font-size: 20px; margin: 0; }
    h2 { font-size: 16px; margin: 0 0 8px; }
    .summary { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 10px 12px; min-width: 110px; }
    .muted { color: #666; }
    .count { color: #666; font-weight: normal; }
    .issue { border: 1px solid #e6e6e6; border-radius: 10px; padding: 12px; margin: 10px 0; }
    .issue-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .badge { font-size: 12px; font-weight: 700; padding: 4px 8px; border-radius: 999px; border: 1px solid #ccc; }
    .badge.high { border-color: #b91c1c; }
    .badge.medium { border-color: #b45309; }
    .badge.low { border-color: #1d4ed8; }
    .rule { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; color: #333; }
    .issue-msg { margin: 6px 0 10px; }
    .meta { font-size: 13px; color: #222; display: grid; gap: 6px; }
    .label { color: #666; }
    code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
    a { color: #0b57d0; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; border: 1px solid #e6e6e6; border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #efefef; vertical-align: top; font-size: 13px; }
    th { background: #f8f8f8; font-weight: 600; }
    tr:last-child td { border-bottom: none; }
  </style>
</head>
<body>
  <header>
    <h1>A11y Audit Report - ${escapeHtml(report.domain || "")}</h1>
    <div class="muted">
      Scanned: ${escapeHtml(report.scannedAt || "")} | Mode: ${escapeHtml(report.scanMode || "debug")} | Pages: ${scannedPages} | A11y issues: ${total}
    </div>
    <div class="summary">
      <div class="card"><b>High</b><div>${grouped.high.length}</div></div>
      <div class="card"><b>Medium</b><div>${grouped.medium.length}</div></div>
      <div class="card"><b>Low</b><div>${grouped.low.length}</div></div>
      <div class="card"><b>Distinct rules</b><div>${summary.topRecurringIssues?.length || 0}</div></div>
    </div>
  </header>

  ${renderTopRecurring()}
  ${renderPagesList()}
  ${renderSection("High severity", grouped.high)}
  ${renderSection("Medium severity", grouped.medium)}
  ${renderSection("Low severity", grouped.low)}

</body>
</html>`;
}

function generateSlideViewerHtml(report) {
  const observations = buildA11yObservations(report);
  const summary = report.summary || buildReportSummary(report);
  const grouped = {
    high: observations.filter((x) => x.severity === "high").length,
    medium: observations.filter((x) => x.severity === "medium").length,
    low: observations.filter((x) => x.severity === "low").length,
  };

  function renderObservationSlide(issue) {
    const relShot = relativeFromOutput(report.outputDir, issue.screenshot);
    const target = compactText(
      Array.isArray(issue.sampleTarget) ? issue.sampleTarget.join(", ") : issue.sampleTarget
    );

    return `
      <section class="slide">
        <div class="slide-top">
          <div class="obs-id">Observation ${issue.observationNumber}</div>
          <div class="sev ${escapeHtml(issue.severity)}">${escapeHtml(String(issue.severity || "low").toUpperCase())}</div>
        </div>
        <div class="slide-body">
          <aside class="meta">
            <h3>${escapeHtml(issue.ruleId)}</h3>
            <p class="msg">${escapeHtml(issue.message)}</p>
            <div class="line"><span>Page</span><a href="${escapeHtml(issue.url)}" target="_blank" rel="noopener">${escapeHtml(issue.url)}</a></div>
            ${issue.pageTitle ? `<div class="line"><span>Title</span><strong>${escapeHtml(issue.pageTitle)}</strong></div>` : ""}
            ${target ? `<div class="line"><span>Target</span><code>${escapeHtml(target)}</code></div>` : ""}
            ${issue.helpUrl ? `<div class="line"><span>Help</span><a href="${escapeHtml(issue.helpUrl)}" target="_blank" rel="noopener">${escapeHtml(issue.helpUrl)}</a></div>` : ""}
          </aside>
          <div class="shot">
            ${
              relShot
                ? `<img src="${escapeHtml(relShot)}" alt="Observation screenshot ${issue.observationNumber}" loading="lazy" />`
                : `<div class="empty">No screenshot available</div>`
            }
          </div>
        </div>
      </section>
    `;
  }

  const topRecurring = (summary.topRecurringIssues || [])
    .slice(0, 8)
    .map((item, idx) => {
      return `<li>${idx + 1}. <code>${escapeHtml(item.ruleId)}</code> - ${item.count} issue(s) on ${item.pagesAffected} page(s)</li>`;
    })
    .join("");

  const slides = observations.map(renderObservationSlide).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>A11y Slide Viewer - ${escapeHtml(report.domain || "")}</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #111827;
      --panel-soft: #1f2937;
      --text: #f8fafc;
      --muted: #cbd5e1;
      --accent: #60a5fa;
      --border: #334155;
      --high: #fecaca;
      --high-line: #dc2626;
      --med: #fde68a;
      --med-line: #d97706;
      --low: #bfdbfe;
      --low-line: #2563eb;
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; }
    body {
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      background: radial-gradient(1200px 800px at 20% -10%, #1e293b, var(--bg));
      color: var(--text);
      overflow: hidden;
    }

    .viewport { height: 100%; display: grid; grid-template-rows: auto 1fr auto; }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      background: rgba(15, 23, 42, 0.92);
      backdrop-filter: blur(3px);
    }

    .toolbar .left { display: flex; align-items: center; gap: 8px; }
    .brand { font-weight: 700; }
    .counter { color: var(--muted); font-size: 13px; }
    .nav { display: flex; align-items: center; gap: 8px; }
    button {
      border: 1px solid var(--border);
      background: var(--panel-soft);
      color: var(--text);
      border-radius: 8px;
      padding: 7px 12px;
      cursor: pointer;
      font-weight: 600;
    }
    button:disabled { opacity: 0.45; cursor: not-allowed; }

    .deck {
      height: 100%;
      overflow: hidden;
      position: relative;
    }

    .slide {
      display: none;
      width: 100%;
      height: 100%;
      padding: 18px;
    }

    .slide.active { display: block; }

    .card {
      height: 100%;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: linear-gradient(160deg, rgba(15,23,42,0.95), rgba(30,41,59,0.95));
      box-shadow: 0 8px 24px rgba(2, 6, 23, 0.35);
      padding: 18px;
      overflow: hidden;
    }

    .cover h1 { margin: 0 0 6px; font-size: 30px; }
    .cover .sub { margin: 0; color: var(--muted); }
    .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
    .pill { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; background: rgba(30,41,59,0.75); }
    .list-wrap { margin-top: 14px; }
    .list-wrap ul { margin: 8px 0 0 18px; padding: 0; }
    .list-wrap li { margin: 4px 0; color: var(--muted); }

    .slide-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .obs-id { font-size: 20px; font-weight: 700; }
    .sev {
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid var(--border);
    }
    .sev.high { background: var(--high); border-color: var(--high-line); color: #7f1d1d; }
    .sev.medium { background: var(--med); border-color: var(--med-line); color: #78350f; }
    .sev.low { background: var(--low); border-color: var(--low-line); color: #1e3a8a; }

    .slide-body {
      display: grid;
      grid-template-columns: 34% 66%;
      gap: 12px;
      height: calc(100% - 44px);
    }

    .meta {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(17, 24, 39, 0.8);
      padding: 12px;
      overflow: auto;
    }
    .meta h3 { margin: 0 0 8px; font-size: 17px; }
    .msg { margin: 0 0 10px; color: var(--muted); font-size: 14px; }
    .line { margin: 7px 0; font-size: 13px; display: grid; gap: 3px; }
    .line span { color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px; }
    .line a { color: var(--accent); text-decoration: none; word-break: break-word; }
    .line strong { color: var(--text); }
    .line code { display: inline-block; max-width: 100%; overflow-wrap: anywhere; }

    .shot {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: #0b1220;
      padding: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 180px;
      overflow: hidden;
    }
    .shot img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      border-radius: 8px;
      background: #fff;
    }
    .empty { color: var(--muted); font-size: 15px; }

    .footer {
      padding: 8px 16px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px;
    }

    @media (max-width: 980px) {
      .slide-body { grid-template-columns: 1fr; }
      .toolbar { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <div class="viewport">
    <header class="toolbar">
      <div class="left">
        <span class="brand">A11y Slide Viewer</span>
        <span class="counter" id="counter"></span>
      </div>
      <div class="nav">
        <button id="prevBtn" type="button">Previous</button>
        <button id="nextBtn" type="button">Next</button>
      </div>
    </header>

    <main class="deck" id="deck">
      <section class="slide active">
        <div class="card cover">
          <h1>A11y Audit Slides - ${escapeHtml(report.domain || report.startUrl || "Website")}</h1>
          <p class="sub">Scanned at ${escapeHtml(report.scannedAt || "-")} | Mode: ${escapeHtml(report.scanMode || "debug")}</p>
          <div class="stats">
            <div class="pill"><strong>Observations:</strong> ${observations.length}</div>
            <div class="pill"><strong>Pages:</strong> ${report.pages?.length || 0}</div>
            <div class="pill"><strong>High:</strong> ${grouped.high}</div>
            <div class="pill"><strong>Medium:</strong> ${grouped.medium}</div>
            <div class="pill"><strong>Low:</strong> ${grouped.low}</div>
          </div>
          <div class="list-wrap">
            <strong>Top recurring rules</strong>
            ${topRecurring ? `<ul>${topRecurring}</ul>` : `<p class="sub">No recurring issues.</p>`}
          </div>
        </div>
      </section>

      ${slides}
    </main>

    <footer class="footer">
      Tip: Use Left/Right arrow keys to navigate.
    </footer>
  </div>

  <script>
    const slides = Array.from(document.querySelectorAll(".slide"));
    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");
    const counter = document.getElementById("counter");
    const total = slides.length;
    let index = 0;

    function updateCounter() {
      counter.textContent = "Slide " + (index + 1) + " / " + total;
      prevBtn.disabled = index <= 0;
      nextBtn.disabled = index >= total - 1;
    }

    function showSlide(nextIndex) {
      if (nextIndex < 0 || nextIndex >= total) return;
      slides[index].classList.remove("active");
      index = nextIndex;
      slides[index].classList.add("active");
      updateCounter();
      const u = new URL(window.location.href);
      u.searchParams.set("slide", String(index + 1));
      history.replaceState(null, "", u);
    }

    prevBtn.addEventListener("click", () => showSlide(index - 1));
    nextBtn.addEventListener("click", () => showSlide(index + 1));

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowLeft") showSlide(index - 1);
      if (ev.key === "ArrowRight") showSlide(index + 1);
    });

    const fromQuery = Number(new URL(window.location.href).searchParams.get("slide") || "1");
    if (Number.isFinite(fromQuery) && fromQuery >= 1 && fromQuery <= total) {
      slides[0].classList.remove("active");
      index = fromQuery - 1;
      slides[index].classList.add("active");
    }

    updateCounter();
  </script>
</body>
</html>`;
}

async function generateSlidesPdfFromHtml(slidesHtmlPath, pdfPath) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const htmlUrl = pathToFileURL(path.resolve(slidesHtmlPath)).toString();
    await page.goto(htmlUrl, { waitUntil: "networkidle", timeout: 30000 });

    // Force printable mode: render all slides, each on a separate page.
    await page.addStyleTag({
      content: `
        .toolbar, .footer { display: none !important; }
        body { overflow: visible !important; background: #fff !important; }
        .viewport { display: block !important; height: auto !important; }
        .deck { height: auto !important; overflow: visible !important; }
        .slide {
          display: block !important;
          height: auto !important;
          padding: 0 !important;
          page-break-after: always !important;
          break-after: page !important;
        }
        .slide:last-child {
          page-break-after: auto !important;
          break-after: auto !important;
        }
        .card {
          min-height: 180mm !important;
          height: auto !important;
          border-color: #d1d5db !important;
          box-shadow: none !important;
          background: #fff !important;
          color: #111827 !important;
        }
        .meta, .shot {
          border-color: #d1d5db !important;
          background: #fff !important;
          color: #111827 !important;
        }
        .line span { color: #4b5563 !important; }
        .line a, a { color: #1d4ed8 !important; }
      `,
    });

    await page.pdf({
      path: pdfPath,
      format: "A4",
      landscape: true,
      printBackground: true,
      margin: { top: "8mm", right: "8mm", bottom: "8mm", left: "8mm" },
    });
  } finally {
    await browser.close();
  }
}

async function generatePowerPointReport(report, pptPath) {
  const observations = buildA11yObservations(report);
  const summary = report.summary || buildReportSummary(report);
  const grouped = {
    high: observations.filter((x) => x.severity === "high").length,
    medium: observations.filter((x) => x.severity === "medium").length,
    low: observations.filter((x) => x.severity === "low").length,
  };

  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "AI Web Accessibility Auditor";
  pptx.company = "AI Web Accessibility Auditor";
  pptx.subject = `Accessibility scan for ${report.domain || report.startUrl || "site"}`;
  pptx.title = `A11y Audit Report - ${report.domain || "Website"}`;

  const palette = {
    bg: "F8FAFC",
    panel: "FFFFFF",
    border: "D9E2EC",
    accent: "0B63CE",
    text: "111827",
    muted: "475467",
  };

  const severityStyle = {
    high: { fill: "FEE2E2", line: "B91C1C", text: "7F1D1D" },
    medium: { fill: "FEF3C7", line: "B45309", text: "7C2D12" },
    low: { fill: "DBEAFE", line: "1D4ED8", text: "1E3A8A" },
  };

  const scanStamp = compactText(report.scannedAt || "");

  let slide = pptx.addSlide();
  slide.background = { color: palette.bg };
  slide.addShape(pptx.ShapeType.roundRect, {
    x: 0.45,
    y: 0.45,
    w: 12.45,
    h: 6.55,
    fill: { color: palette.panel },
    line: { color: palette.border, pt: 1 },
    radius: 0.08,
  });
  slide.addText("Accessibility Audit Report", {
    x: 0.95,
    y: 1.15,
    w: 8.5,
    h: 0.7,
    fontSize: 32,
    bold: true,
    color: palette.text,
  });
  slide.addText(report.domain || report.startUrl || "Website", {
    x: 0.95,
    y: 2.0,
    w: 8.5,
    h: 0.45,
    fontSize: 18,
    color: palette.accent,
    bold: true,
  });
  slide.addText(
    `Mode: ${report.scanMode || "debug"} | Pages scanned: ${report.pages?.length || 0} | Observations: ${observations.length}`,
    {
      x: 0.95,
      y: 2.55,
      w: 11.3,
      h: 0.4,
      fontSize: 13,
      color: palette.muted,
    }
  );
  slide.addText(`Scanned at: ${scanStamp || "-"}`, {
    x: 0.95,
    y: 2.95,
    w: 11.3,
    h: 0.35,
    fontSize: 11,
    color: palette.muted,
  });

  slide = pptx.addSlide();
  slide.background = { color: palette.bg };
  slide.addText("Scan Summary", {
    x: 0.55,
    y: 0.35,
    w: 6.2,
    h: 0.55,
    fontSize: 24,
    bold: true,
    color: palette.text,
  });

  const cards = [
    { label: "High", value: grouped.high, color: severityStyle.high },
    { label: "Medium", value: grouped.medium, color: severityStyle.medium },
    { label: "Low", value: grouped.low, color: severityStyle.low },
    { label: "Pages", value: report.pages?.length || 0, color: { fill: "E0F2FE", line: "0369A1", text: "0C4A6E" } },
  ];

  cards.forEach((card, idx) => {
    const x = 0.55 + idx * 3.2;
    slide.addShape(pptx.ShapeType.roundRect, {
      x,
      y: 1.1,
      w: 2.8,
      h: 1.2,
      fill: { color: card.color.fill },
      line: { color: card.color.line, pt: 1 },
      radius: 0.06,
    });
    slide.addText(card.label, {
      x: x + 0.2,
      y: 1.3,
      w: 2.4,
      h: 0.3,
      fontSize: 12,
      bold: true,
      color: card.color.text,
      align: "center",
    });
    slide.addText(String(card.value), {
      x: x + 0.2,
      y: 1.62,
      w: 2.4,
      h: 0.5,
      fontSize: 28,
      bold: true,
      color: palette.text,
      align: "center",
    });
  });

  slide.addText("Top recurring rules", {
    x: 0.55,
    y: 2.65,
    w: 4.5,
    h: 0.35,
    fontSize: 15,
    bold: true,
    color: palette.text,
  });

  const recurring = (summary.topRecurringIssues || []).slice(0, 8);
  if (!recurring.length) {
    slide.addText("No recurring a11y rules detected.", {
      x: 0.55,
      y: 3.05,
      w: 8.5,
      h: 0.35,
      fontSize: 12,
      color: palette.muted,
    });
  } else {
    recurring.forEach((item, idx) => {
      slide.addText(`${idx + 1}. ${truncateText(item.ruleId, 64)} - ${item.count} issue(s)`, {
        x: 0.75,
        y: 3.05 + idx * 0.34,
        w: 9.0,
        h: 0.3,
        fontSize: 12,
        color: palette.text,
      });
    });
  }

  if (!observations.length) {
    slide = pptx.addSlide();
    slide.background = { color: palette.bg };
    slide.addText("Observations", {
      x: 0.55,
      y: 0.6,
      w: 4.0,
      h: 0.5,
      fontSize: 22,
      bold: true,
      color: palette.text,
    });
    slide.addText("No accessibility observations found for this scan.", {
      x: 0.55,
      y: 1.3,
      w: 8.0,
      h: 0.4,
      fontSize: 14,
      color: palette.muted,
    });
  }

  for (const issue of observations) {
    const sev = severityStyle[issue.severity] || severityStyle.low;
    slide = pptx.addSlide();
    slide.background = { color: palette.bg };

    slide.addText(`Observation ${issue.observationNumber}`, {
      x: 0.45,
      y: 0.25,
      w: 3.2,
      h: 0.42,
      fontSize: 16,
      bold: true,
      color: palette.text,
    });

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 3.1,
      y: 0.25,
      w: 1.5,
      h: 0.38,
      fill: { color: sev.fill },
      line: { color: sev.line, pt: 1 },
      radius: 0.06,
    });
    slide.addText(String(issue.severity || "low").toUpperCase(), {
      x: 3.1,
      y: 0.28,
      w: 1.5,
      h: 0.3,
      fontSize: 11,
      bold: true,
      color: sev.text,
      align: "center",
    });

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.45,
      y: 0.82,
      w: 4.15,
      h: 6.32,
      fill: { color: "FFFFFF" },
      line: { color: palette.border, pt: 1 },
      radius: 0.06,
    });

    slide.addText("Rule", {
      x: 0.65,
      y: 1.05,
      w: 0.8,
      h: 0.26,
      fontSize: 10,
      bold: true,
      color: palette.muted,
    });
    slide.addText(truncateText(issue.ruleId, 70), {
      x: 0.65,
      y: 1.28,
      w: 3.75,
      h: 0.45,
      fontSize: 13,
      bold: true,
      color: palette.text,
    });

    slide.addText("Observation", {
      x: 0.65,
      y: 1.86,
      w: 2.4,
      h: 0.26,
      fontSize: 10,
      bold: true,
      color: palette.muted,
    });
    slide.addText(truncateText(issue.message, 340), {
      x: 0.65,
      y: 2.08,
      w: 3.75,
      h: 1.2,
      fontSize: 11,
      color: palette.text,
      valign: "top",
    });

    slide.addText("Page URL", {
      x: 0.65,
      y: 3.45,
      w: 2.4,
      h: 0.26,
      fontSize: 10,
      bold: true,
      color: palette.muted,
    });
    slide.addText(truncateText(issue.url, 210), {
      x: 0.65,
      y: 3.67,
      w: 3.75,
      h: 0.72,
      fontSize: 10,
      color: palette.text,
      valign: "top",
    });

    if (issue.pageTitle) {
      slide.addText("Page title", {
        x: 0.65,
        y: 4.52,
        w: 2.4,
        h: 0.26,
        fontSize: 10,
        bold: true,
        color: palette.muted,
      });
      slide.addText(truncateText(issue.pageTitle, 150), {
        x: 0.65,
        y: 4.74,
        w: 3.75,
        h: 0.62,
        fontSize: 10,
        color: palette.text,
        valign: "top",
      });
    }

    const sampleTarget = Array.isArray(issue.sampleTarget)
      ? issue.sampleTarget.join(", ")
      : issue.sampleTarget;
    if (sampleTarget) {
      slide.addText("Sample target", {
        x: 0.65,
        y: 5.5,
        w: 2.4,
        h: 0.26,
        fontSize: 10,
        bold: true,
        color: palette.muted,
      });
      slide.addText(truncateText(sampleTarget, 170), {
        x: 0.65,
        y: 5.72,
        w: 3.75,
        h: 0.56,
        fontSize: 10,
        color: palette.text,
      });
    }

    if (issue.helpUrl) {
      slide.addText("Axe help", {
        x: 0.65,
        y: 6.42,
        w: 1.0,
        h: 0.26,
        fontSize: 10,
        bold: true,
        color: palette.muted,
      });
      slide.addText(truncateText(issue.helpUrl, 130), {
        x: 0.65,
        y: 6.62,
        w: 3.75,
        h: 0.32,
        fontSize: 10,
        color: palette.accent,
        underline: { color: palette.accent },
        hyperlink: { url: issue.helpUrl },
      });
    }

    const screenshotPath = issue.screenshot ? path.resolve(issue.screenshot) : null;
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 4.85,
      y: 0.82,
      w: 8.05,
      h: 6.32,
      fill: { color: "FFFFFF" },
      line: { color: palette.border, pt: 1 },
      radius: 0.06,
    });

    if (screenshotPath && fs.existsSync(screenshotPath)) {
      slide.addImage({
        path: screenshotPath,
        x: 5.02,
        y: 1.02,
        w: 7.7,
        h: 5.78,
      });
      slide.addText(path.basename(screenshotPath), {
        x: 5.02,
        y: 6.86,
        w: 7.7,
        h: 0.2,
        fontSize: 9,
        color: palette.muted,
        align: "right",
      });
    } else {
      slide.addShape(pptx.ShapeType.rect, {
        x: 5.02,
        y: 1.02,
        w: 7.7,
        h: 5.78,
        fill: { color: "F3F4F6" },
        line: { color: "D1D5DB", pt: 1, dash: "dash" },
      });
      slide.addText("No screenshot available for this observation", {
        x: 5.22,
        y: 3.78,
        w: 7.3,
        h: 0.5,
        fontSize: 14,
        color: "6B7280",
        align: "center",
      });
    }
  }

  await pptx.writeFile({ fileName: pptPath });
}

(async () => {
  const startParsed = new URL(START_URL);
  const FORCE_PROTOCOL = startParsed.protocol;

  const startNorm = normalizeUrl(START_URL, { forceProtocol: FORCE_PROTOCOL });
  if (!startNorm) {
    console.error("Invalid START_URL:", START_URL);
    process.exit(1);
  }

  const DOMAIN = new URL(startNorm).hostname;
  const OUT_DIR = path.join("output", safeFolderName(DOMAIN));
  const SHOTS_DIR = path.join(OUT_DIR, "screenshots");
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const LIVE_PREVIEW_PATH = path.join(OUT_DIR, "live.png");
  console.log(`Scan mode: ${SCAN_MODE}`);
  if (LIVE_PREVIEW_ENABLED) console.log(`Preview PNG: ${LIVE_PREVIEW_PATH}`);

  const browser = await chromium.launch({
    headless: !SHOW_BROWSER,
    slowMo: SLOW_MO_MS,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  const visited = new Set();
  const enqueued = new Set();

  const queue = [{ url: startNorm, depth: 0 }];
  enqueued.add(startNorm);

  const report = {
    startUrl: startNorm,
    scanMode: SCAN_MODE,
    domain: DOMAIN,
    scannedAt: new Date().toISOString(),
    maxPages: MAX_PAGES,
    maxDepth: MAX_DEPTH,
    maxClicksPerPage: MAX_CLICKS_PER_PAGE,
    screenshotPolicy: "one_per_page_viewport_only",
    outputDir: OUT_DIR,
    livePreviewPng: LIVE_PREVIEW_ENABLED ? LIVE_PREVIEW_PATH : null,
    pages: [],
  };

  const CLICK_QUERY =
    'button, a[href], [role="button"], input[type="button"], input[type="submit"]';

  while (queue.length && report.pages.length < MAX_PAGES) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    console.log(`Visiting (${report.pages.length + 1}/${MAX_PAGES}) depth=${depth}: ${url}`);

    const pageResult = {
      url,
      depth,
      title: null,
      screenshot: null,
      consoleErrors: [],
      requestFailures: [],
      actions: [],
      issues: [],
      a11y: null,
      a11yError: null,
    };

    page.on("console", (msg) => {
      if (msg.type() === "error") pageResult.consoleErrors.push(msg.text());
    });

    page.on("requestfailed", (req) => {
      pageResult.requestFailures.push({
        url: req.url(),
        failure: req.failure()?.errorText || "unknown",
      });
    });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      pageResult.title = await page.title();
      await dismissCookieBanners(page);

      if (LIVE_PREVIEW_ENABLED) {
        try {
          await page.screenshot({ path: LIVE_PREVIEW_PATH, fullPage: LIVE_PREVIEW_FULLPAGE });
        } catch {}
      }

      if (TAKE_ONE_SCREENSHOT_PER_PAGE) {
        const shotName = `${safeFilename(url)}__page.png`;
        const shotPath = path.join(SHOTS_DIR, shotName);
        await page.screenshot({ path: shotPath, fullPage: PAGE_SCREENSHOT_FULLPAGE });
        pageResult.screenshot = shotPath;
      }

      try {
        const axeResults = await new AxeBuilder({ page }).analyze();
        pageResult.a11y = {
          passes: axeResults.passes?.length || 0,
          incomplete: axeResults.incomplete?.length || 0,
          inapplicable: axeResults.inapplicable?.length || 0,
          violations: (axeResults.violations || []).map((v) => ({
            id: v.id,
            impact: v.impact || null,
            description: v.description,
            help: v.help,
            helpUrl: v.helpUrl,
            tags: v.tags,
            nodes: (v.nodes || []).slice(0, MAX_AXE_NODES_PER_VIOLATION).map((n) => ({
              target: n.target,
              html: (n.html || "").slice(0, MAX_AXE_HTML_CHARS),
              failureSummary: n.failureSummary,
            })),
          })),
        };

        for (const v of pageResult.a11y.violations) {
          pageResult.issues.push({
            ruleId: `a11y:${v.id}`,
            severity: impactToSeverity(v.impact),
            message: `${v.help} (${v.impact || "unknown impact"})`,
            evidence: {
              url: pageResult.url,
              screenshot: pageResult.screenshot,
              helpUrl: v.helpUrl,
              sampleTarget: v.nodes?.[0]?.target || null,
            },
          });
        }
      } catch (e) {
        pageResult.a11yError = String(e);
      }

      const currentNorm = normalizeUrl(page.url(), { forceProtocol: FORCE_PROTOCOL }) || url;

      const clickables = await page.$$eval(
        CLICK_QUERY,
        (els) =>
          els
            .map((el, idx) => {
              const text =
                (el.innerText || "").trim() ||
                (el.getAttribute("aria-label") || "").trim() ||
                (el.getAttribute("title") || "").trim() ||
                (el.value || "").trim();

              const tag = el.tagName.toLowerCase();
              const href = tag === "a" ? el.href : null;
              const disabled =
                el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

              return { idx, tag, text, href, disabled };
            })
            .filter((x) => !x.disabled)
      );

      const clickedSignatures = new Set();
      const candidates = [];

      for (const c of clickables) {
        const text = c.text || "";
        if (looksDangerous(text)) continue;

        const sig = `${c.tag}|${text.toLowerCase().slice(0, 80)}|${(c.href || "")
          .toLowerCase()
          .slice(0, 200)}`;
        if (clickedSignatures.has(sig)) continue;

        if (c.tag === "a" && c.href) {
          if (c.href.includes("#")) continue;
          if (shouldSkipLink(c.href)) continue;
          if (!sameDomain(startNorm, c.href)) continue;

          const hrefNorm = normalizeUrl(c.href, { forceProtocol: FORCE_PROTOCOL });
          if (!hrefNorm) continue;
          if (hrefNorm === currentNorm) continue;
          if (visited.has(hrefNorm) || enqueued.has(hrefNorm)) continue;

          candidates.push({ ...c, hrefNorm, sig });
        } else {
          candidates.push({ ...c, hrefNorm: null, sig });
        }

        if (candidates.length >= MAX_CLICKS_PER_PAGE) break;
      }

      for (const target of candidates) {
        clickedSignatures.add(target.sig);

        const action = {
          type: "click",
          target: { tag: target.tag, text: target.text, href: target.href },
          beforeUrl: normalizeUrl(page.url(), { forceProtocol: FORCE_PROTOCOL }) || page.url(),
          afterUrl: null,
          urlChanged: false,
          skippedBecauseVisited: false,
          error: null,
        };

        try {
          const locator = page.locator(CLICK_QUERY).nth(target.idx);
          await locator.scrollIntoViewIfNeeded();
          await locator.waitFor({ state: "visible", timeout: CLICK_TIMEOUT_MS });

          const oldUrl = normalizeUrl(page.url(), { forceProtocol: FORCE_PROTOCOL }) || page.url();
          await locator.click({ timeout: CLICK_TIMEOUT_MS });

          await Promise.race([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 3000 }).catch(() => null),
            page.waitForTimeout(POST_CLICK_WAIT_MS),
          ]);

          const newUrl = normalizeUrl(page.url(), { forceProtocol: FORCE_PROTOCOL }) || page.url();
          action.afterUrl = newUrl;
          action.urlChanged = newUrl !== oldUrl;

          if (LIVE_PREVIEW_ENABLED) {
            try {
              await page.screenshot({ path: LIVE_PREVIEW_PATH, fullPage: LIVE_PREVIEW_FULLPAGE });
            } catch {}
          }

          if (action.urlChanged) {
            if (visited.has(newUrl)) action.skippedBecauseVisited = true;
            await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => null);
          }
        } catch (e) {
          action.error = String(e);
        }

        pageResult.actions.push(action);
      }

      if (depth < MAX_DEPTH) {
        const rawLinks = await page.$$eval("a[href]", (as) => as.map((a) => a.href).filter(Boolean));
        for (const raw of rawLinks) {
          if (shouldSkipLink(raw)) continue;
          if (!sameDomain(startNorm, raw)) continue;

          const norm = normalizeUrl(raw, { forceProtocol: FORCE_PROTOCOL });
          if (!norm) continue;
          if (norm === currentNorm) continue;
          if (visited.has(norm) || enqueued.has(norm)) continue;

          enqueued.add(norm);
          queue.push({ url: norm, depth: depth + 1 });
        }
      }
    } catch (e) {
      pageResult.error = String(e);
      console.log("  Page error:", pageResult.error);
    }

    report.pages.push(pageResult);
    page.removeAllListeners("console");
    page.removeAllListeners("requestfailed");
  }

  await browser.close();

  report.summary = buildReportSummary(report);

  const reportPath = path.join(OUT_DIR, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const htmlPath = path.join(OUT_DIR, "report.html");
  fs.writeFileSync(htmlPath, generateHtmlReport(report), "utf-8");

  const slidesHtmlPath = path.join(OUT_DIR, "report-slides.html");
  fs.writeFileSync(slidesHtmlPath, generateSlideViewerHtml(report), "utf-8");

  const slidesPdfPath = path.join(OUT_DIR, "report-slides.pdf");
  let hasSlidesPdf = false;
  try {
    await generateSlidesPdfFromHtml(slidesHtmlPath, slidesPdfPath);
    hasSlidesPdf = true;
  } catch (e) {
    console.log(`Report Slides PDF skipped: ${String(e)}`);
  }

  const pptxPath = path.join(OUT_DIR, "report.pptx");
  await generatePowerPointReport(report, pptxPath);

  console.log(`Done. Scanned ${report.pages.length} pages.`);
  console.log(`Report JSON: ${reportPath}`);
  console.log(`Report HTML: ${htmlPath}`);
  console.log(`Report Slides HTML: ${slidesHtmlPath}`);
  if (hasSlidesPdf) console.log(`Report Slides PDF: ${slidesPdfPath}`);
  console.log(`Report PPTX: ${pptxPath}`);
})();
