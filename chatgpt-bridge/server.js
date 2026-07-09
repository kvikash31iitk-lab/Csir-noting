/*
 * Local ChatGPT browser bridge for CSIR Note Sheet.
 *
 * This is intentionally local-only. It opens a visible browser, uses your
 * normal ChatGPT session, and exposes a small localhost API compatible with
 * the note app's /generate endpoint.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PORT = parseInt(process.env.PORT || "8790", 10);
const HOST = process.env.HOST || "127.0.0.1";
const PROFILE_DIR =
  process.env.CHATGPT_PROFILE_DIR || path.join(__dirname, "profile");
const CHATGPT_URL = process.env.CHATGPT_URL || "https://chatgpt.com/";
const BROWSER_CHANNEL = process.env.CHATGPT_BROWSER_CHANNEL || "chrome";
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "240000", 10);
const STABLE_CHECKS = parseInt(process.env.STABLE_CHECKS || "3", 10);
const SKIP_BROWSER_OPEN = process.env.CHATGPT_SKIP_BROWSER_OPEN === "1";

let context = null;
let page = null;
let queue = Promise.resolve();

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Private-Network": "true",
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        req.destroy();
        reject(new Error("request too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function withQueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function launchContext() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const baseOptions = {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      ...baseOptions,
      channel: BROWSER_CHANNEL,
    });
  } catch (e) {
    console.warn(
      "[bridge] Could not launch channel " +
        BROWSER_CHANNEL +
        "; falling back to Playwright Chromium."
    );
    return await chromium.launchPersistentContext(PROFILE_DIR, baseOptions);
  }
}

async function getPage() {
  if (!context) context = await launchContext();
  if (!page || page.isClosed()) page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(15000);
  return page;
}

async function findPrompt(p, timeoutMs) {
  const selectors = [
    "#prompt-textarea",
    "div[contenteditable='true'][id='prompt-textarea']",
    "textarea[placeholder*='Message']",
    "div[contenteditable='true']",
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const loc = p.locator(selector).last();
      try {
        if ((await loc.count()) && (await loc.isVisible())) return loc;
      } catch (_) {}
    }
    await p.waitForTimeout(500);
  }
  return null;
}

async function ensureChatReady(p) {
  await p.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
  const prompt = await findPrompt(p, 20000);
  if (prompt) return prompt;
  throw new Error(
    "ChatGPT is not ready. In the bridge browser, log in to chatgpt.com, handle any checks, then retry."
  );
}

async function setPromptText(p, loc, text) {
  await loc.click();
  await loc.evaluate((el, value) => {
    el.focus();
    if ("value" in el) {
      el.value = value;
    } else {
      el.textContent = value;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }, text);
  await p.waitForTimeout(250);
}

async function clickSend(p) {
  const selectors = [
    "button[data-testid='send-button']",
    "button[aria-label*='Send']",
  ];
  for (const selector of selectors) {
    const loc = p.locator(selector).last();
    try {
      if ((await loc.count()) && (await loc.isVisible()) && (await loc.isEnabled())) {
        await loc.click();
        return;
      }
    } catch (_) {}
  }
  await p.keyboard.press("Enter");
}

async function assistantCount(p) {
  return await p.locator("[data-message-author-role='assistant']").count();
}

async function lastAssistantText(p) {
  const loc = p.locator("[data-message-author-role='assistant']").last();
  if (!(await loc.count())) return "";
  return (await loc.innerText()).trim();
}

async function isGenerating(p) {
  const selectors = [
    "button[data-testid='stop-button']",
    "button[aria-label*='Stop']",
    "[data-testid='composer-speech-button']",
  ];
  for (const selector of selectors) {
    try {
      const loc = p.locator(selector).first();
      if ((await loc.count()) && (await loc.isVisible())) {
        if (selector.indexOf("speech") !== -1) continue;
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function waitForAnswer(p, previousCount) {
  const started = Date.now();
  let last = "";
  let stable = 0;

  while (Date.now() - started < REQUEST_TIMEOUT_MS) {
    const count = await assistantCount(p);
    const text = count > previousCount ? await lastAssistantText(p) : "";
    const generating = await isGenerating(p);

    if (text && text === last && !generating) stable += 1;
    else stable = 0;
    last = text || last;

    if (last && stable >= STABLE_CHECKS) return last;
    await p.waitForTimeout(1000);
  }
  throw new Error("Timed out waiting for ChatGPT response");
}

function buildPrompt(system, user) {
  return (
    "You are serving a local CSIR Note Sheet app. Follow the instructions exactly. " +
    "If JSON is requested, output raw JSON only, with no markdown fences.\n\n" +
    "SYSTEM INSTRUCTIONS:\n" +
    (system || "(none)") +
    "\n\nUSER REQUEST:\n" +
    user
  );
}

async function generate(system, user) {
  if (!user || !String(user).trim()) throw new Error("missing user prompt");
  const p = await getPage();
  const prompt = await ensureChatReady(p);
  const previousCount = await assistantCount(p);
  await setPromptText(p, prompt, buildPrompt(system, user));
  await clickSend(p);
  return await waitForAnswer(p, previousCount);
}

async function route(req, res) {
  if (req.method === "OPTIONS") return json(res, 204, {});
  const url = new URL(req.url, "http://" + req.headers.host);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      bridge: "chatgpt-browser",
      localOnly: true,
      profileDir: PROFILE_DIR,
    });
  }

  if (req.method === "GET" && url.pathname === "/auth/config") {
    return json(res, 200, { google: false, usersEnabled: false, localBridge: true });
  }

  if (req.method === "GET" && url.pathname === "/brain") {
    return json(res, 200, { learning: [], references: [], rules: [], notes: [] });
  }

  if (req.method === "GET" && url.pathname === "/brain/rules/search") {
    return json(res, 200, { results: [] });
  }

  if (req.method === "POST" && url.pathname === "/brain/note") {
    return json(res, 200, { ok: true, localBridge: true });
  }

  if (req.method === "POST" && url.pathname === "/generate") {
    try {
      const body = await readBody(req);
      const text = await withQueue(() => generate(body.system || "", body.user || ""));
      return json(res, 200, { content: [{ type: "text", text }] });
    } catch (e) {
      const message = String((e && e.message) || e);
      const status = /log in|not ready/i.test(message) ? 401 : /timed out/i.test(message) ? 504 : 500;
      return json(res, status, { error: message, code: status === 401 ? "login_required" : "bridge_error" });
    }
  }

  return json(res, 404, { error: "not found" });
}

http
  .createServer((req, res) => {
    route(req, res).catch((e) => json(res, 500, { error: String((e && e.message) || e) }));
  })
  .listen(PORT, HOST, () => {
    console.log("ChatGPT bridge listening at http://" + HOST + ":" + PORT);
    console.log("Open the app settings and use Backend URL: http://localhost:" + PORT + "/generate");
    if (!SKIP_BROWSER_OPEN) {
      getPage().catch((e) => console.warn("[bridge] Browser launch deferred:", e.message));
    }
  });

process.on("SIGINT", async () => {
  try { if (context) await context.close(); } catch (_) {}
  process.exit(0);
});
