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

  // The button that copies the address for an agent.
  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var source = document.querySelector("[data-copy-text]");
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
})();
