// crawl.js
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const AxeBuilder = require("@axe-core/playwright").default;

const START_URL = process.argv[2];
if (!START_URL) {
  console.error("Usage: node crawl.js https://example.com");
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
const SHOW_BROWSER = true; // set false for faster runs
const SLOW_MO_MS = 0;
const NAV_TIMEOUT_MS = 15000;
const CLICK_TIMEOUT_MS = 6000;
const POST_CLICK_WAIT_MS = 250;

// Screenshot policy: ONE per page (viewport-only)
const TAKE_ONE_SCREENSHOT_PER_PAGE = true;
const PAGE_SCREENSHOT_FULLPAGE = false;

// Live preview (this is what the UI displays)
const LIVE_PREVIEW_ENABLED = true; // writes output/<domain>/live.png continuously
const LIVE_PREVIEW_FULLPAGE = false; // keep false so it doesn't scroll visibly

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

// Strong URL normalization to reduce duplicates
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

    const drop = new Set([
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
    for (const k of [...u.searchParams.keys()]) {
      if (drop.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    u.searchParams.sort();

    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");

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

// --- HTML report helpers ---
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

function generateHtmlReport(report) {
  const allIssues = [];
  for (const p of report.pages || []) {
    for (const issue of p.issues || []) {
      if (String(issue.ruleId || "").startsWith("a11y:")) {
        allIssues.push({
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
  }

  const order = { high: 0, medium: 1, low: 2 };
  allIssues.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  const grouped = {
    high: allIssues.filter((x) => x.severity === "high"),
    medium: allIssues.filter((x) => x.severity === "medium"),
    low: allIssues.filter((x) => x.severity === "low"),
  };

  const total = allIssues.length;
  const scannedPages = report.pages?.length || 0;

  function renderIssue(issue) {
    const relShot =
      issue.screenshot && report.outputDir
        ? toPosixPath(path.relative(report.outputDir, issue.screenshot))
        : null;

    const url = escapeHtml(issue.url);
    const title = escapeHtml(issue.pageTitle);
    const ruleId = escapeHtml(issue.ruleId);
    const msg = escapeHtml(issue.message);
    const helpUrl = escapeHtml(issue.helpUrl);
    const target = escapeHtml(
      Array.isArray(issue.sampleTarget) ? issue.sampleTarget.join(", ") : issue.sampleTarget
    );

    const screenshotLink = relShot
      ? `<a href="${escapeHtml(relShot)}" target="_blank" rel="noopener">Screenshot</a>`
      : `<span class="muted">No screenshot</span>`;

    const helpLink = helpUrl
      ? `<a href="${helpUrl}" target="_blank" rel="noopener">Axe help</a>`
      : `<span class="muted">No help link</span>`;

    return `
      <div class="issue">
        <div class="issue-head">
          <span class="badge ${issue.severity}">${issue.severity.toUpperCase()}</span>
          <span class="rule">${ruleId}</span>
        </div>
        <div class="issue-msg">${msg}</div>
        <div class="meta">
          <div><span class="label">Page:</span> <a href="${url}" target="_blank" rel="noopener">${url}</a></div>
          ${title ? `<div><span class="label">Title:</span> ${title}</div>` : ""}
          ${target ? `<div><span class="label">Sample target:</span> <code>${target}</code></div>` : ""}
          <div class="links">${screenshotLink} · ${helpLink}</div>
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>A11y Audit Report - ${escapeHtml(report.domain || "")}</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; color: #111; }
    header { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
    .summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0 0; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 10px 12px; }
    h1 { font-size: 20px; margin: 0; }
    h2 { font-size: 16px; margin-top: 22px; border-top: 1px solid #eee; padding-top: 16px; }
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
    .links { margin-top: 2px; }
  </style>
</head>
<body>
  <header>
    <h1>A11y Audit Report — ${escapeHtml(report.domain || "")}</h1>
    <div class="muted">
      Scanned: ${escapeHtml(report.scannedAt || "")} · Pages: ${scannedPages} · A11y issues: ${total}
    </div>
    <div class="summary">
      <div class="card"><b>High</b><div>${grouped.high.length}</div></div>
      <div class="card"><b>Medium</b><div>${grouped.medium.length}</div></div>
      <div class="card"><b>Low</b><div>${grouped.low.length}</div></div>
    </div>
  </header>

  ${renderSection("High severity", grouped.high)}
  ${renderSection("Medium severity", grouped.medium)}
  ${renderSection("Low severity", grouped.low)}

</body>
</html>`;
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

  // Print this early so the server/UI can start the preview immediately
  console.log(`Preview PNG: ${LIVE_PREVIEW_PATH}`);

  const browser = await chromium.launch({
    headless: !SHOW_BROWSER,
    slowMo: SLOW_MO_MS,
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
    domain: DOMAIN,
    scannedAt: new Date().toISOString(),
    maxPages: MAX_PAGES,
    maxDepth: MAX_DEPTH,
    maxClicksPerPage: MAX_CLICKS_PER_PAGE,
    screenshotPolicy: "one_per_page_viewport_only",
    outputDir: OUT_DIR,
    livePreviewPng: LIVE_PREVIEW_PATH,
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

      // Live preview (overwritten every page visit)
      if (LIVE_PREVIEW_ENABLED) {
        try {
          await page.screenshot({ path: LIVE_PREVIEW_PATH, fullPage: LIVE_PREVIEW_FULLPAGE });
        } catch {
          // ignore preview errors (never fail the scan because of preview)
        }
      }

      // One screenshot per page
      if (TAKE_ONE_SCREENSHOT_PER_PAGE) {
        const shotName = safeFilename(url) + "__page.png";
        const shotPath = path.join(SHOTS_DIR, shotName);
        await page.screenshot({ path: shotPath, fullPage: PAGE_SCREENSHOT_FULLPAGE });
        pageResult.screenshot = shotPath;
      }

      // A11y scan
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

      // Button testing (skip loops & visited)
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
                el.hasAttribute("disabled") ||
                el.getAttribute("aria-disabled") === "true";

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

          const hrefNorm = normalizeUrl(c.href, { forceProtocol: FORCE_PROTOCOL });
          if (!hrefNorm) continue;

          if (visited.has(hrefNorm) || enqueued.has(hrefNorm)) continue;
          if (hrefNorm === currentNorm) continue;

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

          // Update preview after click too (optional, but feels more “live”)
          if (LIVE_PREVIEW_ENABLED) {
            try {
              await page.screenshot({ path: LIVE_PREVIEW_PATH, fullPage: LIVE_PREVIEW_FULLPAGE });
            } catch {}
          }

          if (action.urlChanged && visited.has(newUrl)) {
            action.skippedBecauseVisited = true;
            await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => null);
          } else if (action.urlChanged) {
            await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => null);
          }
        } catch (e) {
          action.error = String(e);
        }

        pageResult.actions.push(action);
      }

      // Enqueue internal links
      if (depth < MAX_DEPTH) {
        const rawLinks = await page.$$eval("a[href]", (as) => as.map((a) => a.href).filter(Boolean));

        for (const raw of rawLinks) {
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

  const reportPath = path.join(OUT_DIR, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const htmlPath = path.join(OUT_DIR, "report.html");
  fs.writeFileSync(htmlPath, generateHtmlReport(report), "utf-8");

  console.log(`Done. Scanned ${report.pages.length} pages.`);
  console.log(`Report JSON: ${reportPath}`);
  console.log(`Report HTML: ${htmlPath}`);
})();
