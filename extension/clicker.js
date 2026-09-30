// Runs in a background tab that the extension opened for one Gulpy connect, on the app's
// sign-in or consent page. It taps Allow, or picks the signed-in account. The last value is the result.
(() => {
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
  const text = document.body ? document.body.innerText : "";
  const NO = /\b(deny|cancel|decline|reject|don.?t allow|no thanks|go back|sign ?out|log ?out|use another account)\b/i;
  const YES =
    /^(allow( access)?|allow and continue|authori[sz]e\b.*|approve|accept|grant( access)?|connect( app)?|continue|confirm|yes|agree)\b/i;

  const buttons = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(
    (el) => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true",
  );
  const yes = buttons.find((el) => YES.test(label(el)) && !NO.test(label(el)));
  const password = [...document.querySelectorAll('input[type="password"]')].some(visible);
  const emptyEmail = [...document.querySelectorAll('input[type="email"], input[name*="email" i], input[autocomplete="username"]')].some(
    (el) => visible(el) && !el.value,
  );

  // Not signed in to this app: skip it. The user signs in there first.
  if (password || emptyEmail) return { state: "login" };
  // Act only on a page that asks for Gulpy, so that no other app gets an Allow.
  if (!/gulpy/i.test(text) && !/gulpy/i.test(document.title)) {
    return /\b(sign in|log in|sign up|create (an )?account)\b/i.test(text) ? { state: "login" } : { state: "unclear" };
  }
  // Boxes that the page needs before Allow, for example "I recognize and trust this URL".
  for (const box of document.querySelectorAll('input[type="checkbox"]')) {
    const own = box.closest("label") || (box.id && document.querySelector(`label[for="${CSS.escape(box.id)}"]`));
    const words = own ? own.innerText : "";
    if (!box.checked && visible(box) && /trust|recogni[sz]e|understand|i agree/i.test(words)) box.click();
  }
  if (yes) {
    yes.scrollIntoView({ block: "center" });
    yes.click();
    return { state: "clicked", label: label(yes).slice(0, 40) };
  }
  // An account picker: the signed-in account is the first choice.
  const account = buttons.find((el) => /@/.test(label(el)) && !NO.test(label(el)));
  if (account) {
    account.click();
    return { state: "clicked", label: "account" };
  }
  return { state: "unclear" };
})();
