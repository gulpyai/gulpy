// Sends the browser to the address of the agent after the user decides.
// The wait lets the user see the result before the window changes.
(function () {
  var link = document.getElementById("leave");
  if (!link) return;
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var wait = still ? 300 : Number(link.dataset.delay || 0);
  setTimeout(function () {
    window.location.replace(link.href);
  }, wait);
})();
