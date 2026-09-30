// Small helpers for the pages. Each page works with no script: these add comfort.
(function () {
  "use strict";

  // The search box of the tool list hides the rows that do not match.
  document.querySelectorAll("[data-catalog]").forEach(function (catalog) {
    var input = catalog.querySelector("[data-catalog-search]");
    var empty = catalog.querySelector("[data-catalog-empty]");
    if (!input) return;

    input.addEventListener("input", function () {
      var words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      var shown = 0;
      catalog.querySelectorAll("[data-catalog-group]").forEach(function (group) {
        var inGroup = 0;
        group.querySelectorAll("[data-search]").forEach(function (card) {
          var match = words.every(function (word) {
            return card.dataset.search.indexOf(word) !== -1;
          });
          card.hidden = !match;
          if (match) inGroup += 1;
        });
        group.hidden = inGroup === 0;
        shown += inGroup;
      });
      if (empty) empty.hidden = shown !== 0;
    });
  });

  // Each button copies the text in its own box: the sentence for an agent, or the address.
  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var box = button.parentElement;
      var source = box && box.querySelector("[data-copy-text]");
      var label = button.querySelector("[data-copy-label]");
      if (!source || !navigator.clipboard) return;
      navigator.clipboard.writeText(source.textContent.trim()).then(function () {
        if (!label) return;
        label.textContent = "Copied";
        setTimeout(function () {
          label.textContent = "Copy";
        }, 1600);
      });
    });
  });

  // The tabs of the dashboard. With no script, all the panels show, one after the other.
  document.querySelectorAll("[data-tabs]").forEach(function (tabs) {
    var links = tabs.querySelectorAll("[data-tab-link]");
    var panels = document.querySelectorAll("[data-tab]");
    var names = Array.prototype.map.call(links, function (link) {
      return link.dataset.tabLink;
    });

    function show(name) {
      links.forEach(function (link) {
        var on = link.dataset.tabLink === name;
        link.setAttribute("aria-selected", on ? "true" : "false");
      });
      panels.forEach(function (panel) {
        panel.hidden = panel.dataset.tab !== name;
      });
    }

    function fromHash() {
      var name = location.hash.slice(1);
      return names.indexOf(name) !== -1 ? name : names[0];
    }

    links.forEach(function (link) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        show(link.dataset.tabLink);
        history.replaceState(null, "", "#" + link.dataset.tabLink);
      });
    });
    window.addEventListener("hashchange", function () {
      show(fromHash());
    });
    document.documentElement.classList.add("has-tabs");
    show(fromHash());
  });

  // The Edit form of an agent saves each choice at once, in the background. With no script, Save sends the form.
  document.querySelectorAll("[data-access]").forEach(function (form) {
    var status = form.querySelector("[data-access-status]");
    var save = form.querySelector("[data-access-save]");
    var agent = form.closest(".agent");
    var count = agent && agent.querySelector("[data-agent-count]");
    var timer = null;
    var hide = null;
    if (save) save.hidden = true;

    function say(text, kind) {
      clearTimeout(hide);
      status.textContent = text;
      status.className = "access-status" + (kind ? " access-status-" + kind : "");
    }

    function allOff() {
      return Array.prototype.every.call(form.querySelectorAll("input[type=radio]:checked"), function (input) {
        return input.value === "off";
      });
    }

    function send() {
      // Everything off removes the agent. That needs the Remove access button, so a tap never does it by mistake.
      if (allOff()) {
        say("Everything is off. To remove this agent, select Remove access.", "warn");
        return;
      }
      say("Saving…");
      fetch(form.action, {
        method: "POST",
        body: new URLSearchParams(new FormData(form)),
        headers: { accept: "application/json" },
        credentials: "same-origin",
      })
        .then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        })
        .then(function (result) {
          if (!result.ok) throw new Error("not saved");
          if (count) {
            count.textContent =
              result.tools === result.total ? "All " + result.total + " tools" : result.tools + " of " + result.total + " tools";
          }
          say("Saved", "ok");
          hide = setTimeout(function () {
            say("");
          }, 1800);
        })
        .catch(function () {
          say("Not saved. Check your connection and try again.", "warn");
        });
    }

    form.addEventListener("change", function () {
      clearTimeout(timer);
      timer = setTimeout(send, 200);
    });
    form.addEventListener("submit", function (event) {
      if (event.submitter && event.submitter.hasAttribute("formaction")) return;
      event.preventDefault();
      send();
    });
  });
})();
