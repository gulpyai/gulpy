// Runs on the last page of Link. Sends the result to the page that opened the window.
(function () {
  var node = document.getElementById("gulpy-result");
  if (!node) return;
  var data = node.dataset;
  var message = { source: "gulpy", type: data.type };
  if (data.type === "success") {
    message.publicToken = data.publicToken;
    message.accounts = JSON.parse(data.accounts || "[]");
  }
  try {
    // Only the origin that the link token was made for can read the message.
    if (window.opener) window.opener.postMessage(message, data.origin);
  } catch (error) {
    // The opener also asks the server for the result, so a failure here is not a problem.
  }
  setTimeout(function () {
    window.close();
  }, data.type === "success" ? 900 : 200);
})();
