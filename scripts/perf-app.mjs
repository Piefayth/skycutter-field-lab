#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";

const DEFAULT_PORT = 5177;
const DEFAULT_RECIPE = "planet-wind-moisture";
const DEFAULT_SECONDS = 10;

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.outDir ?? "perf");
const seconds = Number(args.seconds ?? DEFAULT_SECONDS);
const requestedPort = Number(args.port ?? 0);
let port = requestedPort;
let baseUrl = args.url ?? null;
const recipe = args.recipe ?? DEFAULT_RECIPE;
const view = args.view ?? null;
const preset = args.preset ?? null;
const renderCheck = Boolean(args.renderCheck);
const traceEnabled = Boolean(args.trace);
const headed = Boolean(args.headed);
const cpuRender = Boolean(args.cpuRender);

let server = null;
let browser = null;

try {
  await mkdir(outDir, { recursive: true });
  if (!args.url) {
    port = requestedPort || await findOpenPort(DEFAULT_PORT);
    baseUrl = `http://127.0.0.1:${port}/`;
    server = await startVite(port);
  }

  browser = await launchBrowser({ headed });
  const context = await browser.newContext({
    viewport: { width: Number(args.width ?? 1280), height: Number(args.height ?? 800) },
    deviceScaleFactor: Number(args.dpr ?? 1),
  });
  await context.addInitScript(() => {
    window.__FIELD_LAB_PERF__ = { spans: Object.create(null) };
  });
  if (cpuRender) {
    await context.addInitScript(() => {
      window.__FIELD_LAB_GPU_SURFACE_DISABLED__ = true;
      window.__FIELD_LAB_GPU_RENDER_DISABLED__ = true;
    });
  }
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    const type = msg.type();
    if (["error", "warning"].includes(type)) {
      consoleMessages.push({ type, text: msg.text() });
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(String(error?.stack ?? error?.message ?? error));
  });

  if (traceEnabled) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForApp(page);
  await chooseSelect(page, "#recipeSelect", recipe);
  if (preset) await chooseSelect(page, "#presetSelect", preset);
  if (view) await chooseSelect(page, "#viewSelect", view);
  await settle(page);

  const selected = await page.evaluate(() => ({
    recipe: document.querySelector("#recipeSelect")?.value ?? null,
    preset: document.querySelector("#presetSelect")?.value ?? null,
    view: document.querySelector("#viewSelect")?.value ?? null,
    stats: document.querySelector("#stats")?.textContent ?? null,
    webgpu: Boolean(navigator.gpu),
  }));

  const warmupMs = Number(args.warmupMs ?? (renderCheck ? 1000 : 2500));
  await page.waitForTimeout(warmupMs);
  await page.evaluate(() => {
    if (window.__FIELD_LAB_PERF__) window.__FIELD_LAB_PERF__.spans = Object.create(null);
  });
  const frameStats = await sampleFrames(page, seconds);
  const spans = await page.evaluate(() => window.__FIELD_LAB_PERF__?.spans ?? {});
  const debug = await page.evaluate(() => window.__FIELD_LAB_DEBUG__?.() ?? null);
  const screenshotPath = path.join(outDir, `${renderCheck ? "rendercheck" : "perf"}-${selected.recipe}-${Date.now()}.png`);
  await page.locator(await visibleViewportSelector(page)).screenshot({ path: screenshotPath });

  let tracePath = null;
  if (traceEnabled) {
    tracePath = path.join(outDir, `trace-${selected.recipe}-${Date.now()}.zip`);
    await context.tracing.stop({ path: tracePath });
  }

  const result = {
    ok: pageErrors.length === 0 && !hasSevereConsoleError(consoleMessages),
    mode: renderCheck ? "rendercheck" : "perf",
    gpuRenderEnabled: Boolean(debug?.gpuSurfaceActive),
    gpuRenderDisabled: !debug?.gpuSurfaceActive,
    gpuSurfaceRequested: Boolean(debug?.gpuSurface),
    url: baseUrl,
    selected,
    seconds,
    warmupMs,
    frameStats,
    spans: normalizeSpans(spans),
    consoleMessages,
    pageErrors,
    artifacts: {
      screenshot: path.relative(process.cwd(), screenshotPath),
      trace: tracePath ? path.relative(process.cwd(), tracePath) : null,
    },
  };
  const resultPath = path.join(outDir, "latest.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  printSummary(result, resultPath);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  if (String(error?.message ?? error).includes("Executable doesn't exist")) {
    console.error("Playwright browser is not installed. Run: npx playwright install chromium");
  }
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (server) {
    server.kill("SIGTERM");
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = toCamel(arg.slice(2));
    if (key === "renderCheck") {
      out.renderCheck = true;
    } else if (["trace", "headed", "cpuRender", "gpuRender"].includes(key)) {
      out[key] = true;
    } else {
      out[key] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function toCamel(key) {
  return key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

async function startVite(port) {
  const server = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  server.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(output.trim());
    }
  });
  await waitForUrl(`http://127.0.0.1:${port}/`, 20_000);
  return server;
}

async function findOpenPort(startPort) {
  for (let candidate = startPort; candidate < startPort + 100; candidate++) {
    if (await canListen(candidate)) return candidate;
  }
  throw new Error(`Could not find an open port starting at ${startPort}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${lastError.message}` : ""}`);
}

async function launchBrowser({ headed }) {
  return chromium.launch({
    headless: !headed,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-webgpu-developer-features",
      "--ignore-gpu-blocklist",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
}

async function waitForApp(page) {
  await page.waitForSelector("#viewport, #viewportSurface", { timeout: 30_000 });
  await page.waitForFunction(() => {
    const surface = document.querySelector("#viewportSurface");
    const viewport = document.querySelector("#viewport");
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== "none";
    };
    return visible(surface) || visible(viewport);
  }, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const select = document.querySelector("#recipeSelect");
    return select && select.options.length > 0;
  }, { timeout: 30_000 });
}

async function chooseSelect(page, selector, wanted) {
  await page.waitForSelector(selector, { timeout: 15_000 });
  const picked = await page.evaluate(({ selector, wanted }) => {
    const select = document.querySelector(selector);
    if (!select) return null;
    const options = [...select.options];
    const match = options.find((option) =>
      option.value === wanted ||
      option.textContent?.trim() === wanted ||
      option.textContent?.toLowerCase().includes(String(wanted).toLowerCase())
    );
    if (!match) return null;
    select.value = match.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return match.value;
  }, { selector, wanted });
  if (!picked) {
    const choices = await page.evaluate((selector) =>
      [...document.querySelector(selector)?.options ?? []].map((option) => option.value),
    selector);
    throw new Error(`${selector}: could not find "${wanted}". Choices: ${choices.join(", ")}`);
  }
  await page.waitForFunction(({ selector, picked }) =>
    document.querySelector(selector)?.value === picked,
  { selector, picked }, { timeout: 10_000 });
  await settle(page);
}

async function settle(page) {
  await page.waitForTimeout(250);
  await page.waitForFunction(() => {
    const el = document.querySelector("#viewportSurface") ?? document.querySelector("#viewport");
    return el?.clientWidth > 0;
  }, { timeout: 10_000 });
}

async function visibleViewportSelector(page) {
  return page.evaluate(() => {
    const candidates = ["#viewportSurface", "#viewport"];
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden") {
        return selector;
      }
    }
    return "#viewport";
  });
}

async function sampleFrames(page, seconds) {
  return page.evaluate((durationMs) => new Promise((resolve) => {
    const frames = [];
    let start = 0;
    let last = 0;
    function tick(now) {
      if (!start) {
        start = now;
        last = now;
        requestAnimationFrame(tick);
        return;
      }
      frames.push(now - last);
      last = now;
      if (now - start >= durationMs) {
        const sorted = [...frames].sort((a, b) => a - b);
        const sum = frames.reduce((acc, value) => acc + value, 0);
        const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))] ?? 0;
        resolve({
          frames: frames.length,
          avgMs: sum / Math.max(1, frames.length),
          fps: frames.length / (durationMs / 1000),
          p50Ms: percentile(0.50),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
          maxMs: sorted[sorted.length - 1] ?? 0,
          longFramesOver33ms: frames.filter((value) => value > 33.33).length,
          longFramesOver50ms: frames.filter((value) => value > 50).length,
        });
      } else {
        requestAnimationFrame(tick);
      }
    }
    requestAnimationFrame(tick);
  }), seconds * 1000);
}

function hasSevereConsoleError(messages) {
  return messages.some((msg) =>
    msg.type === "error" &&
    !/WebGPU.*experimental|GPU.*warning/i.test(msg.text)
  );
}

function normalizeSpans(spans) {
  return Object.fromEntries(Object.entries(spans).map(([name, span]) => [
    name,
    {
      ...span,
      avgMs: span.count ? span.totalMs / span.count : 0,
    },
  ]).sort((a, b) => b[1].totalMs - a[1].totalMs));
}

function printSummary(result, resultPath) {
  const stats = result.frameStats;
  console.log(`recipe: ${result.selected.recipe} / view: ${result.selected.view}`);
  console.log(`fps: ${stats.fps.toFixed(1)} avg: ${stats.avgMs.toFixed(2)}ms p95: ${stats.p95Ms.toFixed(2)}ms max: ${stats.maxMs.toFixed(2)}ms`);
  console.log(`long frames >33ms: ${stats.longFramesOver33ms}, >50ms: ${stats.longFramesOver50ms}`);
  const spans = Object.entries(result.spans ?? {}).slice(0, 8);
  if (spans.length > 0) {
    console.log("top spans:");
    for (const [name, span] of spans) {
      console.log(`  ${name}: total ${span.totalMs.toFixed(1)}ms, avg ${span.avgMs.toFixed(2)}ms, max ${span.maxMs.toFixed(2)}ms, count ${span.count}`);
    }
  }
  console.log(`screenshot: ${result.artifacts.screenshot}`);
  if (result.artifacts.trace) console.log(`trace: ${result.artifacts.trace}`);
  console.log(`json: ${path.relative(process.cwd(), resultPath)}`);
  if (result.pageErrors.length || hasSevereConsoleError(result.consoleMessages)) {
    console.log("browser errors captured; see json for details");
  }
}
