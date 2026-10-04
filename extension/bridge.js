// Runs on the Gulpy page /connect-all only. It passes messages between the page and the extension.
(() => {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data || {};
    if (data.source !== "gulpy-page") return;
    if (data.type === "ping") {
      chrome.runtime
        .sendMessage({ type: "ping" })
        .then(() => window.postMessage({ source: "gulpy-ext", type: "pong" }, location.origin))
        .catch(() => {});
    }
    if (data.type === "connect-all") chrome.runtime.sendMessage({ type: "connect-all", items: data.items });
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.source === "gulpy-ext") window.postMessage(message, location.origin);
  });
})();
