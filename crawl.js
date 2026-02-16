// crawl.js
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

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

// Speed / visibility
const SHOW_BROWSER = true;
const SLOW_MO_MS = 0;
const NAV_TIMEOUT_MS = 15000;
const CLICK_TIMEOUT_MS = 6000;
const POST_CLICK_WAIT_MS = 250;

// Screenshot policy: ONE per page (viewport-only, no visible full-page scroll)
const TAKE_ONE_SCREENSHOT_PER_PAGE = true;
const PAGE_SCREENSHOT_FULLPAGE = false;

// Safety deny-list
const CLICK_DENY_WORDS = [
  "delete", "remove", "logout", "log out", "sign out", "unsubscribe",
  "pay", "purchase", "checkout", "order", "confirm", "submit", "cancel",
  "billing", "settings",
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

// Stronger URL normalization to avoid "same page" duplicates
function normalizeUrl(inputUrl, { dropWww = true, forceProtocol = null } = {}) {
  try {
    const u = new URL(inputUrl);

    // Force protocol to match start (avoids http/https dupes)
    if (forceProtocol) u.protocol = forceProtocol;

    // Lowercase host
    u.hostname = u.hostname.toLowerCase();

    // Optional: treat www.example.com and example.com as same
    if (dropWww && u.hostname.startsWith("www.")) {
      u.hostname = u.hostname.slice(4);
    }

    // Remove default ports
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) {
      u.port = "";
    }

    // Drop hash
    u.hash = "";

    // Drop common tracking params
    const drop = new Set([
      "utm_source","utm_medium","utm_campaign","utm_term","utm_content",
      "gclid","fbclid","ref","ref_src"
    ]);
    for (const k of [...u.searchParams.keys()]) {
      if (drop.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    u.searchParams.sort();

    // Normalize trailing slash (keep "/" only for root)
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
    // Compare without www.
    const ah = a.hostname.toLowerCase().replace(/^www\./, "");
    const bh = b.hostname.toLowerCase().replace(/^www\./, "");
    return ah === bh;
  } catch {
    return false;
  }
}

(async () => {
  const startParsed = new URL(START_URL);
  const FORCE_PROTOCOL = startParsed.protocol; // lock to http: or https:

  const startNorm = normalizeUrl(START_URL, { forceProtocol: FORCE_PROTOCOL });
  if (!startNorm) {
    console.error("Invalid START_URL:", START_URL);
    process.exit(1);
  }

  const DOMAIN = new URL(startNorm).hostname;
  const OUT_DIR = path.join("output", safeFolderName(DOMAIN));
  const SHOTS_DIR = path.join(OUT_DIR, "screenshots");
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: !SHOW_BROWSER,
    slowMo: SLOW_MO_MS,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  // Dedup sets
  const visited = new Set();  // normalized urls scanned
  const enqueued = new Set(); // normalized urls already queued

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
    pages: [],
  };

  const CLICK_QUERY =
    'button, a[href], [role="button"], input[type="button"], input[type="submit"]';

  while (queue.length && report.pages.length < MAX_PAGES) {
    const { url, depth } = queue.shift();

    if (visited.has(url)) continue; // extra guard
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

      // ONE screenshot per page
      if (TAKE_ONE_SCREENSHOT_PER_PAGE) {
        const shotName = safeFilename(url) + "__page.png";
        const shotPath = path.join(SHOTS_DIR, shotName);
        await page.screenshot({ path: shotPath, fullPage: PAGE_SCREENSHOT_FULLPAGE });
        pageResult.screenshot = shotPath;
      }

      // --- Button testing (skip navigations to already-visited pages) ---
      const currentNorm = normalizeUrl(page.url(), { forceProtocol: FORCE_PROTOCOL }) || url;

      const clickables = await page.$$eval(CLICK_QUERY, (els) =>
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

      // Per-page dedupe: don't click the same “kind” of target twice
      const clickedSignatures = new Set();

      // Pre-filter to avoid loops & revisits (especially links)
      const candidates = [];
      for (const c of clickables) {
        const text = c.text || "";
        if (looksDangerous(text)) continue;

        // Signature: tag + text + href
        const sig = `${c.tag}|${text.toLowerCase().slice(0, 80)}|${(c.href || "").toLowerCase()}`;
        if (clickedSignatures.has(sig)) continue;

        if (c.tag === "a" && c.href) {
          // Skip anchors + same-page
          if (c.href.includes("#")) continue;

          const hrefNorm = normalizeUrl(c.href, { forceProtocol: FORCE_PROTOCOL });
          if (!hrefNorm) continue;

          // Skip if it would go to a page already visited OR already queued
          if (visited.has(hrefNorm) || enqueued.has(hrefNorm)) continue;

          // Skip same current page
          if (hrefNorm === currentNorm) continue;

          candidates.push({ ...c, hrefNorm, sig });
        } else {
          // Non-link buttons: we can’t know destination; allow, but still dedupe by sig
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

          // If the click navigated to an already visited page, treat as redundant and return immediately.
          if (action.urlChanged && visited.has(newUrl)) {
            action.skippedBecauseVisited = true;
            await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => null);
          } else if (action.urlChanged) {
            // We navigated to a new page; go back so we keep scanning current page consistently
            await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => null);
          }
        } catch (e) {
          action.error = String(e);
        }

        pageResult.actions.push(action);
      }

      // --- Enqueue internal links (dedupe BEFORE enqueue) ---
      if (depth < MAX_DEPTH) {
        const rawLinks = await page.$$eval("a[href]", (as) => as.map((a) => a.href).filter(Boolean));

        for (const raw of rawLinks) {
          if (!sameDomain(startNorm, raw)) continue;

          const norm = normalizeUrl(raw, { forceProtocol: FORCE_PROTOCOL });
          if (!norm) continue;

          // Don't enqueue the current page again
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

    // Cleanup listeners
    page.removeAllListeners("console");
    page.removeAllListeners("requestfailed");
  }

  await browser.close();

  const reportPath = path.join(OUT_DIR, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Done. Scanned ${report.pages.length} pages.`);
  console.log(`Report: ${reportPath}`);
})();
