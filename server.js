const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// Serve UI
app.use("/", express.static(path.join(__dirname, "public")));

// Serve generated output (reports + screenshots + live preview image)
app.use("/output", express.static(path.join(__dirname, "output")));

function isValidHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// scanId -> { status, logs[], reportUrl, reportSlidesUrl, reportPdfUrl, reportPptxUrl, liveUrl, clients:Set(res), child }
const scans = new Map();

function makeScanId() {
  return crypto.randomBytes(8).toString("hex");
}

function normalizeScanMode(rawMode) {
  return rawMode === "fast" ? "fast" : "debug";
}

function eventLine(payloadObj) {
  return `data: ${JSON.stringify(payloadObj)}\n\n`;
}

function writeEvent(res, payloadObj) {
  res.write(eventLine(payloadObj));
}

function pushEvent(scan, payloadObj) {
  const line = eventLine(payloadObj);

  if (payloadObj.type === "log") {
    scan.logs.push(payloadObj.text);
    if (scan.logs.length > 500) scan.logs.shift();
  }

  for (const res of scan.clients) {
    res.write(line);
  }
}

function closeAllClients(scan) {
  for (const res of scan.clients) {
    try {
      res.end();
    } catch {}
  }
  scan.clients.clear();
}

function fsPathToUrl(p) {
  // Convert file-system path (maybe absolute, maybe relative) to served URL like /output/.../file
  let rel = p;
  if (path.isAbsolute(p)) rel = path.relative(__dirname, p);
  rel = rel.replace(/\\/g, "/");
  if (!rel.startsWith("output/")) return null;
  return "/" + rel;
}

// Start scan
app.post("/scan/start", (req, res) => {
  const url = (req.body?.url || "").trim();
  const mode = normalizeScanMode(req.body?.mode);
  if (!isValidHttpUrl(url)) {
    return res.status(400).json({ error: "Please enter a valid http(s) URL." });
  }

  const crawlPath = path.join(__dirname, "crawl.js");
  if (!fs.existsSync(crawlPath)) {
    return res.status(500).json({ error: "crawl.js not found in project root." });
  }

  const scanId = makeScanId();
  const scan = {
    status: "running",
    logs: [],
    reportUrl: null,
    reportSlidesUrl: null,
    reportPdfUrl: null,
    reportPptxUrl: null,
    liveUrl: null,
    clients: new Set(),
    child: null,
    mode,
  };
  scans.set(scanId, scan);

  const child = spawn(process.execPath, [crawlPath, url, `--mode=${mode}`], {
    cwd: __dirname,
    shell: false,
  });
  scan.child = child;

  pushEvent(scan, { type: "status", status: "running", scanId, mode });

  child.stdout.on("data", (d) => {
    const text = d.toString();
    pushEvent(scan, { type: "log", stream: "stdout", text });

    // Preview PNG: <path>
    const previewMatch = text.match(/Preview PNG:\s*(.*)\s*/);
    if (previewMatch && !scan.liveUrl) {
      const previewFsPath = previewMatch[1].trim();
      const liveUrl = fsPathToUrl(previewFsPath);
      if (liveUrl) {
        scan.liveUrl = liveUrl;
        pushEvent(scan, { type: "preview", liveUrl });
      }
    }

    // Report HTML: output/<domain>/report.html
    const reportMatch = text.match(/Report HTML:\s*(.*)\s*/);
    if (reportMatch) {
      const reportHtmlFsPath = reportMatch[1].trim();
      const reportUrl = fsPathToUrl(reportHtmlFsPath);
      if (reportUrl) {
        scan.reportUrl = reportUrl;
        pushEvent(scan, { type: "report", reportUrl });

        // If preview wasn't detected for some reason, infer it
        if (!scan.liveUrl && scan.mode === "debug") {
          const base = reportUrl.replace(/\/report\.html$/, "");
          scan.liveUrl = base + "/live.png";
          pushEvent(scan, { type: "preview", liveUrl: scan.liveUrl });
        }
      }
    }

    // Report PPTX: output/<domain>/report.pptx
    const reportPptxMatch = text.match(/Report PPTX:\s*(.*)\s*/);
    if (reportPptxMatch) {
      const reportPptxFsPath = reportPptxMatch[1].trim();
      const reportPptxUrl = fsPathToUrl(reportPptxFsPath);
      if (reportPptxUrl) {
        scan.reportPptxUrl = reportPptxUrl;
        pushEvent(scan, { type: "reportPptx", reportPptxUrl });
      }
    }

    // Report Slides HTML: output/<domain>/report-slides.html
    const reportSlidesMatch = text.match(/Report Slides HTML:\s*(.*)\s*/);
    if (reportSlidesMatch) {
      const reportSlidesFsPath = reportSlidesMatch[1].trim();
      const reportSlidesUrl = fsPathToUrl(reportSlidesFsPath);
      if (reportSlidesUrl) {
        scan.reportSlidesUrl = reportSlidesUrl;
        pushEvent(scan, { type: "reportSlides", reportSlidesUrl });
      }
    }

    // Report Slides PDF: output/<domain>/report-slides.pdf
    const reportPdfMatch = text.match(/Report Slides PDF:\s*(.*)\s*/);
    if (reportPdfMatch) {
      const reportPdfFsPath = reportPdfMatch[1].trim();
      const reportPdfUrl = fsPathToUrl(reportPdfFsPath);
      if (reportPdfUrl) {
        scan.reportPdfUrl = reportPdfUrl;
        pushEvent(scan, { type: "reportPdf", reportPdfUrl });
      }
    }
  });

  child.stderr.on("data", (d) => {
    pushEvent(scan, { type: "log", stream: "stderr", text: d.toString() });
  });

  child.on("close", (code) => {
    scan.status = code === 0 ? "done" : "failed";
    pushEvent(scan, {
      type: "status",
      status: scan.status,
      code,
      reportUrl: scan.reportUrl,
      reportSlidesUrl: scan.reportSlidesUrl,
      reportPdfUrl: scan.reportPdfUrl,
      reportPptxUrl: scan.reportPptxUrl,
      liveUrl: scan.liveUrl,
      mode: scan.mode,
    });
    closeAllClients(scan);

    // Cleanup scans after 30 minutes
    setTimeout(() => scans.delete(scanId), 30 * 60 * 1000);
  });

  res.json({ scanId, mode });
});

// SSE stream endpoint
app.get("/scan/stream/:scanId", (req, res) => {
  const scan = scans.get(req.params.scanId);
  if (!scan) return res.status(404).end("Scan not found");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  scan.clients.add(res);

  // catch-up
  if (scan.logs.length) {
    writeEvent(res, { type: "log", stream: "buffer", text: scan.logs.join("") });
  }
  writeEvent(res, {
    type: "status",
    status: scan.status,
    reportUrl: scan.reportUrl,
    reportSlidesUrl: scan.reportSlidesUrl,
    reportPdfUrl: scan.reportPdfUrl,
    reportPptxUrl: scan.reportPptxUrl,
    liveUrl: scan.liveUrl,
    mode: scan.mode,
  });
  if (scan.liveUrl) writeEvent(res, { type: "preview", liveUrl: scan.liveUrl });
  if (scan.reportUrl) writeEvent(res, { type: "report", reportUrl: scan.reportUrl });
  if (scan.reportSlidesUrl) writeEvent(res, { type: "reportSlides", reportSlidesUrl: scan.reportSlidesUrl });
  if (scan.reportPdfUrl) writeEvent(res, { type: "reportPdf", reportPdfUrl: scan.reportPdfUrl });
  if (scan.reportPptxUrl) writeEvent(res, { type: "reportPptx", reportPptxUrl: scan.reportPptxUrl });

  const keepAlive = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: "ping", t: Date.now() })}\n\n`);
    } catch {}
  }, 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    scan.clients.delete(res);
  });
});

// Cancel scan
app.post("/scan/cancel/:scanId", (req, res) => {
  const scan = scans.get(req.params.scanId);
  if (!scan) return res.status(404).json({ error: "Scan not found" });
  if (scan.status !== "running") return res.json({ ok: true, status: scan.status });

  try {
    scan.child?.kill();
    scan.status = "cancelled";
    pushEvent(scan, { type: "status", status: "cancelled", mode: scan.mode });
    closeAllClients(scan);
  } catch {}

  return res.json({ ok: true, status: scan.status });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`UI running at http://localhost:${PORT}`);
});
