// The page /connect-all. It talks to the extension Gulpy for Chrome through window.postMessage.
(function () {
  var button = document.querySelector("[data-connect-all]");
  var status = document.querySelector("[data-ext-status]");
  var missing = document.querySelector("[data-ext-missing]");
  var summary = document.querySelector("[data-summary]");
  if (!button || !status) return;

  var LABELS = {
    waiting: "Waiting",
    working: "Connecting…",
    connected: "Connected",
    skipped: "Not signed in, skipped",
    "needs-you": "Needs you",
    failed: "Did not connect",
  };
  var found = false;
  var done = 0;
  var connected = 0;

  function send(message) {
    message.source = "gulpy-page";
    window.postMessage(message, window.location.origin);
  }

  function row(id) {
    return document.querySelector('[data-item="' + id + '"]');
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    var data = event.data || {};
    if (data.source !== "gulpy-ext") return;
    if (data.type === "pong") {
      found = true;
      status.textContent = "Gulpy for Chrome is ready.";
      button.disabled = false;
      if (missing) missing.hidden = true;
    }
    if (data.type === "progress") {
      var item = row(data.id);
      if (!item) return;
      item.setAttribute("data-state", data.status);
      var label = item.querySelector("[data-status]");
      if (label) label.textContent = LABELS[data.status] || data.status;
      if (data.status !== "working" && data.status !== "waiting") {
        done += 1;
        if (data.status === "connected") connected += 1;
        summary.textContent = done + " checked · " + connected + " connected";
      }
    }
    if (data.type === "finished") {
      button.textContent = "Done";
      summary.innerHTML = "";
      var text = document.createTextNode(connected + " connected. ");
      var link = document.createElement("a");
      link.href = "/";
      link.textContent = "Review or remove them on My tools";
      summary.appendChild(text);
      summary.appendChild(link);
    }
  });

  button.addEventListener("click", function () {
    var items = [];
    document.querySelectorAll("[data-item]").forEach(function (item) {
      if (item.getAttribute("data-state") === "connected") return;
      items.push({ id: item.getAttribute("data-item"), url: item.getAttribute("data-url") });
    });
    button.disabled = true;
    button.textContent = "Connecting…";
    send({ type: "connect-all", items: items });
  });

  send({ type: "ping" });
  setTimeout(function () {
    if (found) return;
    status.textContent = "Gulpy for Chrome is not installed.";
    if (missing) missing.hidden = false;
  }, 1500);
})();
