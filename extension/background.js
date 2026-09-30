// Gulpy for Chrome. The page /connect-all asks for a list of connects. For each one, the
// extension opens a background tab, where the user is already signed in to the app, and runs
// clicker.js on the app's page until the tab comes back to Gulpy. Then it closes the tab.
//
// Rules that keep this safe:
// - Only the Gulpy page /connect-all can start it, and only with Gulpy /connect/... addresses.
// - The clicker runs only in tabs that this extension opened for a connect.
// - The clicker acts only on pages that name Gulpy, and skips apps where the user is not signed in.

const CONCURRENCY = 3;
const TIMEOUT_MS = 40_000;
const MAX_CLICKS = 4;
const MAX_TRIES = 8;

/** tabId -> { id, origin, clicks, tries, timer } */
const jobs = new Map();
let queue = [];
let session = null;

const isGulpy = (origin) => origin === "https://app.gulpy.ai" || /^http:\/\/localhost(:\d+)?$/.test(origin);

function tell(message) {
  if (!session) return;
  chrome.tabs.sendMessage(session.pageTabId, { source: "gulpy-ext", ...message }).catch(() => {});
}

function finish(tabId, status) {
  const job = jobs.get(tabId);
  if (!job) return;
  clearTimeout(job.timer);
  jobs.delete(tabId);
  chrome.tabs.remove(tabId).catch(() => {});
  tell({ type: "progress", id: job.id, status });
  session.finished += 1;
  if (session.finished >= session.total) tell({ type: "finished" });
  next();
}

function next() {
  while (session && queue.length > 0 && jobs.size < CONCURRENCY) {
    const item = queue.shift();
    chrome.tabs.create({ url: item.url, active: false }).then((tab) => {
      const timer = setTimeout(() => finish(tab.id, "needs-you"), TIMEOUT_MS);
      jobs.set(tab.id, { id: item.id, origin: item.origin, clicks: 0, tries: 0, timer });
      tell({ type: "progress", id: item.id, status: "working" });
    });
  }
}

async function click(tabId) {
  const job = jobs.get(tabId);
  if (!job) return;
  let result;
  try {
    const [first] = await chrome.scripting.executeScript({ target: { tabId }, files: ["clicker.js"] });
    result = first && first.result;
  } catch {
    result = { state: "unclear" };
  }
  if (!jobs.has(tabId)) return;
  if (result && result.state === "login") return finish(tabId, "skipped");
  if (result && result.state === "clicked") {
    job.clicks += 1;
    if (job.clicks > MAX_CLICKS) finish(tabId, "needs-you");
    return;
  }
  // The page may still be drawing. Look again a little later.
  job.tries += 1;
  if (job.tries >= MAX_TRIES) return finish(tabId, "needs-you");
  setTimeout(() => click(tabId), 1500);
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const job = jobs.get(tabId);
  if (!job || change.status !== "complete" || !tab.url) return;
  const url = new URL(tab.url);
  if (url.origin === job.origin) {
    if (url.pathname === "/connect-all/done") {
      // Gulpy adds connected=<connection id> after a connect, or notice=<reason> when it did not work.
      const ok = url.searchParams.has("connected") || url.searchParams.get("ok") === "connected";
      finish(tabId, ok ? "connected" : "failed");
    }
    return;
  }
  job.tries = 0;
  click(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (jobs.has(tabId)) finish(tabId, "needs-you");
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab || !sender.url) return;
  const page = new URL(sender.url);
  if (!isGulpy(page.origin) || page.pathname !== "/connect-all") return;
  if (message.type === "ping") {
    reply({ ok: true });
    return;
  }
  if (message.type === "connect-all" && Array.isArray(message.items)) {
    const items = message.items.flatMap((item) => {
      if (typeof item.id !== "string" || typeof item.url !== "string") return [];
      const url = new URL(item.url, page.origin);
      // Only a connect on this Gulpy, that returns to /connect-all/done.
      if (url.origin !== page.origin || !url.pathname.startsWith("/connect/")) return [];
      if (url.searchParams.get("next") !== "/connect-all/done") return [];
      return [{ id: item.id, url: url.toString(), origin: page.origin }];
    });
    session = { pageTabId: sender.tab.id, total: items.length, finished: 0 };
    queue = items;
    if (items.length === 0) tell({ type: "finished" });
    next();
  }
});
