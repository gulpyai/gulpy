// Browser code for the agent.
(function () {
  "use strict";

  var root = document.getElementById("app");
  var agentName = root.dataset.name;
  var tagline = root.dataset.tagline;
  var ideas = JSON.parse(root.dataset.ideas || "[]");
  var denied = new URLSearchParams(window.location.search).has("denied");
  var state = { connected: false };
  var turns = [];
  var busy = false;
  var results = {};
  var popup = null;

  // Builds DOM nodes. Text goes in as text, not as HTML: answers and tool results are not trusted input.
  function h(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (name) {
      if (name === "class") node.className = attrs[name];
      else if (attrs[name] !== false && attrs[name] !== null) node.setAttribute(name, attrs[name]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function api(path, body) {
    return fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (response) {
      return response.json();
    });
  }

  // The sign-in is in a small window, as ChatGPT, Claude and Grok do it.
  function connect() {
    var width = 480;
    var height = 780;
    var left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
    var top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
    popup = window.open("/connect", "agent-connect", "popup=yes,width=" + width + ",height=" + height + ",left=" + left + ",top=" + top);
    if (!popup) {
      window.location.assign("/connect");
      return;
    }
    var timer = setInterval(function () {
      if (!popup || !popup.closed) return;
      clearInterval(timer);
      popup = null;
      refresh();
    }, 500);
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin || !event.data || event.data.source !== "agent") return;
    denied = !event.data.connected;
    refresh();
  });

  function logo() {
    return h("span", { class: "logo" }, h("span", { class: "logo-mark" }, agentName.charAt(0)), agentName);
  }

  function renderWelcome() {
    return h(
      "section",
      { class: "welcome" },
      logo(),
      h("h1", null, tagline),
      h("p", null, agentName + " has no tools of its own. Give it the tools that you have in Gulpy."),
      state.removed ? h("p", { class: "note" }, "You removed the access in Gulpy. Connect again to continue.") : null,
      denied ? h("p", { class: "note" }, "You did not approve. Nothing was shared.") : null,
      h("button", { class: "primary big", "data-action": "connect" }, "Connect with Gulpy"),
      h("p", { class: "small" }, "A window opens. You do not give " + agentName + " a password."),
    );
  }

  function renderSteps(steps) {
    if (!steps || steps.length === 0) return null;
    return h.apply(
      null,
      ["div", { class: "steps" }].concat(
        steps.map(function (step) {
          return h("span", { class: step.ok ? "step" : "step step-failed" }, (step.ok ? "Used " : "Blocked: ") + step.tool);
        }),
      ),
    );
  }

  // Shows **bold** text as bold. All other text stays plain text.
  function rich(text) {
    var paragraph = h("p", null);
    text.split(/(\*\*[^*\n]+\*\*)/).forEach(function (part) {
      var bold = /^\*\*([^*\n]+)\*\*$/.exec(part);
      paragraph.appendChild(bold ? h("strong", null, bold[1]) : document.createTextNode(part));
    });
    return paragraph;
  }

  function renderTurn(turn) {
    return h(
      "li",
      { class: "turn turn-" + turn.role },
      turn.role === "agent" ? h("span", { class: "logo-mark small-mark" }, agentName.charAt(0)) : null,
      h("div", { class: "bubble" }, renderSteps(turn.steps), turn.role === "agent" ? rich(turn.text) : h("p", null, turn.text)),
    );
  }

  function example(tool) {
    var args = {};
    tool.required.forEach(function (name) {
      args[name] = "";
    });
    return JSON.stringify(args);
  }

  function renderTool(tool) {
    var result = results[tool.name];
    return h(
      "li",
      { class: "tool" },
      h(
        "div",
        { class: "tool-head" },
        h("span", { class: "mono" }, tool.name),
        h("span", { class: tool.readOnly ? "pill" : "pill pill-write" }, tool.readOnly ? "Reads" : "Writes"),
      ),
      h(
        "div",
        { class: "tool-run" },
        h("input", { class: "args", "data-args": tool.name, value: example(tool), "aria-label": "Input for " + tool.name }),
        h("button", { "data-run": tool.name }, "Run"),
      ),
      result ? h("pre", { class: result.isError ? "result result-error" : "result" }, result.text) : null,
    );
  }

  function renderChat() {
    var list = turns.map(renderTurn);
    if (busy) {
      list.push(
        h(
          "li",
          { class: "turn turn-agent" },
          h("span", { class: "logo-mark small-mark" }, agentName.charAt(0)),
          h("div", { class: "bubble thinking" }, h("i"), h("i"), h("i")),
        ),
      );
    }
    var empty =
      turns.length === 0 && !busy
        ? h(
            "div",
            { class: "ideas" },
            h("h1", null, tagline),
            h.apply(
              null,
              ["div", { class: "idea-row" }].concat(
                ideas.map(function (idea) {
                  return h("button", { class: "idea", "data-idea": idea }, idea);
                }),
              ),
            ),
          )
        : null;

    return h(
      "div",
      { class: "chat" },
      h(
        "header",
        { class: "chat-top" },
        logo(),
        h(
          "div",
          { class: "chat-tools" },
          h("span", { class: "pill pill-live" }, "Gulpy · " + state.tools.length + " tools"),
          h("button", { class: "quiet", "data-action": "connect" }, "Change"),
          h("button", { class: "quiet", "data-action": "disconnect" }, "Disconnect"),
        ),
      ),
      h("div", { class: "chat-body", id: "chat-body" }, empty, h.apply(null, ["ul", { class: "turns" }].concat(list))),
      state.thinks
        ? h(
            "form",
            { class: "ask", "data-ask": "yes" },
            h("input", {
              name: "question",
              placeholder: "Ask " + agentName + " to do something",
              autocomplete: "off",
              disabled: busy ? "disabled" : false,
            }),
            h("button", { class: "primary", type: "submit", disabled: busy ? "disabled" : false }, "Send"),
          )
        : h("p", { class: "note" }, "This computer has no `claude` command, so " + agentName + " cannot think. Run a tool below."),
      h(
        "details",
        { class: "drawer", open: state.thinks ? false : "open" },
        h("summary", null, "Tools from Gulpy (" + state.tools.length + ")"),
        h.apply(null, ["ul", { class: "tool-list" }].concat(state.tools.map(renderTool))),
      ),
    );
  }

  function render() {
    var open = root.querySelector(".drawer");
    var wasOpen = open ? open.open : null;
    root.replaceChildren(state.connected ? renderChat() : renderWelcome());
    var drawer = root.querySelector(".drawer");
    if (drawer && wasOpen !== null) drawer.open = wasOpen;
    var body = document.getElementById("chat-body");
    if (body) body.scrollTop = body.scrollHeight;
    var input = root.querySelector(".ask input");
    if (input && !busy) input.focus();
  }

  function refresh() {
    return api("/api/state").then(function (data) {
      state = data;
      if (data.connected && turns.length === 0 && data.turns) {
        turns = data.turns.map(function (turn) {
          return { role: turn.role, text: turn.text };
        });
      }
      if (!data.connected) turns = [];
      render();
    });
  }

  function ask(question) {
    if (busy || !question) return;
    turns.push({ role: "user", text: question });
    busy = true;
    render();
    api("/api/ask", { question: question })
      .then(function (answer) {
        busy = false;
        if (answer.error === "not_connected") return refresh();
        turns.push({ role: "agent", text: answer.text || "I have no answer.", steps: answer.steps });
        render();
      })
      .catch(function () {
        busy = false;
        turns.push({ role: "agent", text: "The request did not complete." });
        render();
      });
  }

  root.addEventListener("submit", function (event) {
    var form = event.target.closest("[data-ask]");
    if (!form) return;
    event.preventDefault();
    ask(form.elements.question.value.trim());
  });

  root.addEventListener("click", function (event) {
    var idea = event.target.closest("[data-idea]");
    if (idea) return ask(idea.dataset.idea);

    var run = event.target.closest("[data-run]");
    if (run) {
      var name = run.dataset.run;
      var input = root.querySelector('[data-args="' + name + '"]');
      var args = {};
      try {
        args = JSON.parse(input.value || "{}");
      } catch (error) {
        results[name] = { isError: true, text: "The input is not valid JSON." };
        return render();
      }
      run.disabled = true;
      return api("/api/call", { name: name, args: args }).then(function (result) {
        results[name] = result;
        render();
      });
    }

    var action = event.target.closest("[data-action]");
    if (!action) return;
    if (action.dataset.action === "connect") connect();
    if (action.dataset.action === "disconnect") {
      results = {};
      turns = [];
      api("/disconnect", {}).then(refresh);
    }
  });

  refresh();
})();
