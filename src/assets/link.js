/*!
 * Gulpy Link. Add this script to your page, then call Gulpy.open().
 *
 *   <script src="https://YOUR-GULPY-HOST/link.js"></script>
 *
 *   Gulpy.open({
 *     linkToken: () => fetch("/api/link-token", { method: "POST" }).then((r) => r.json()).then((d) => d.link_token),
 *     onSuccess: ({ publicToken, accounts }) => { ... send publicToken to your server ... },
 *     onExit: () => { ... },
 *   });
 *
 * Call Gulpy.open() directly in a click handler. If not, the browser blocks the window.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  var base = script ? new URL(script.src).origin : window.location.origin;
  var active = null;

  function open(options) {
    if (!options || !options.linkToken) throw new Error("Gulpy.open: linkToken is required");
    if (active) {
      active.popup.focus();
      return active.handle;
    }

    var width = 480;
    var height = 720;
    var left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
    var top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
    var features = "popup=yes,width=" + width + ",height=" + height + ",left=" + left + ",top=" + top;

    // Open the window now, in the click. Get the token after that.
    var popup = window.open(base + "/link/loading", "gulpy-link", features);
    if (!popup) {
      finish("exit", { reason: "popup_blocked" });
      return { close: function () {} };
    }

    var state = { popup: popup, token: null, done: false, timer: null, handle: null };
    state.handle = {
      close: function () {
        if (!state.popup.closed) state.popup.close();
      },
    };
    active = state;

    function finish(type, detail) {
      if (state && state.done) return;
      if (state) {
        state.done = true;
        clearInterval(state.timer);
        window.removeEventListener("message", onMessage);
        if (type === "success" && !state.popup.closed) state.popup.close();
      }
      active = null;
      if (type === "success") {
        if (options.onSuccess) options.onSuccess(detail);
      } else if (options.onExit) {
        options.onExit(detail || {});
      }
    }

    function onMessage(event) {
      if (event.origin !== base || !event.data || event.data.source !== "gulpy") return;
      if (event.data.type === "success") {
        finish("success", { publicToken: event.data.publicToken, accounts: event.data.accounts || [] });
      } else if (event.data.type === "exit") {
        finish("exit", { reason: "cancelled" });
      }
    }

    // A provider sign-in page can cut the connection between the two windows.
    // For that reason, also ask the server for the result.
    function poll() {
      if (state.done || !state.token) return;
      var closed = state.popup.closed;
      fetch(base + "/link/status?token=" + encodeURIComponent(state.token), { cache: "no-store" })
        .then(function (response) {
          return response.json();
        })
        .then(function (reply) {
          if (reply.status === "completed") {
            finish("success", { publicToken: reply.public_token, accounts: reply.accounts || [] });
          } else if (reply.status === "exited") {
            finish("exit", { reason: "cancelled" });
          } else if (reply.status === "expired") {
            finish("exit", { reason: "expired" });
          } else if (closed) {
            finish("exit", { reason: "closed" });
          }
        })
        .catch(function () {
          if (closed) finish("exit", { reason: "closed" });
        });
    }

    window.addEventListener("message", onMessage);

    var source = typeof options.linkToken === "function" ? options.linkToken() : options.linkToken;
    Promise.resolve(source)
      .then(function (token) {
        if (typeof token !== "string" || !token) throw new Error("no link token");
        if (state.popup.closed) return finish("exit", { reason: "closed" });
        state.token = token;
        state.popup.location.replace(base + "/link?token=" + encodeURIComponent(token));
        state.timer = setInterval(poll, 1500);
      })
      .catch(function () {
        if (!state.popup.closed) state.popup.close();
        finish("exit", { reason: "no_link_token" });
      });

    return state.handle;
  }

  window.Gulpy = { open: open };
})();
