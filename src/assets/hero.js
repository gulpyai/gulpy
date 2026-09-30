// Start free and Sign in go to #start. Put the cursor in the email field, so the person can type at once.
(function () {
  "use strict";

  function focusEmail() {
    if (location.hash !== "#start") return;
    var email = document.querySelector("#start input[name=email]");
    if (email) email.focus({ preventScroll: true });
  }
  window.addEventListener("hashchange", focusEmail);
  document.querySelectorAll('a[href="#start"], a[href="/#start"]').forEach(function (link) {
    // A second click on the same link does not change the hash, so it fires no hashchange.
    link.addEventListener("click", function () {
      setTimeout(focusEmail, 0);
    });
  });
  focusEmail();
})();

// The picture at the top of the first page. The ring turns, and the mascot eats
// the connectors one at a time. A new connector then comes into the empty place,
// so in time the picture shows each connector. With no script the picture is still.
(function () {
  "use strict";

  var orbit = document.querySelector("[data-gulp-hero]");
  if (!orbit || !window.requestAnimationFrame) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var ring = orbit.querySelector("[data-gulp-ring]");
  var queueBox = orbit.querySelector("[data-gulp-queue]");
  var body = orbit.querySelector("[data-gulp-body]");
  var bubble = orbit.querySelector("[data-gulp-bubble]");
  var mascot = body.querySelector("svg");
  var look = mascot.querySelector(".mascot-look");

  var RADIUS = 170;
  var TURN_MS = 48000; // one full turn of the ring
  var FLY_MS = 1100; // from the ring into the mouth
  var EMPTY_MS = 700; // the place stays empty, then a new connector comes
  var SPAWN_MS = 650;
  var GAP_MS = 2400; // between two bites
  var MOUTH = { x: 0, y: 40 }; // the mouth, from the center of the ring
  var CRUMBS = ["#C9F73A", "#101112", "#FF6B7A", "#ffffff"];
  var TAU = Math.PI * 2;

  var queue = Array.prototype.slice.call(queueBox.children);
  var slots = Array.prototype.slice.call(ring.children).map(function (el, index, all) {
    return { el: el, base: (index / all.length) * TAU, mode: "ring", t0: 0, x: 0, y: 0 };
  });
  if (slots.length === 0) return;

  var angle = 0;
  var last = 0;
  var nextBite = 0;
  var side = 0;
  var eyes = { x: 0, y: 0 };
  var lean = 0;
  var running = false;
  var visible = true;

  orbit.classList.add("is-live");

  function clamp(value) {
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  function easeOutBack(t) {
    var c = 1.9;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  }

  function place(slot, x, y, scale, turn, opacity) {
    slot.x = x;
    slot.y = y;
    slot.el.style.transform =
      "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px) rotate(" + turn.toFixed(1) + "deg) scale(" + scale.toFixed(3) + ")";
    slot.el.style.opacity = opacity === 1 ? "" : String(opacity);
  }

  function ringPoint(slot, now, index) {
    var a = slot.base + angle;
    var bob = Math.sin(now / 700 + index * 1.7) * 3;
    return { x: Math.cos(a) * RADIUS, y: Math.sin(a) * RADIUS + bob };
  }

  function busy() {
    return slots.some(function (slot) {
      return slot.mode === "fly";
    });
  }

  // The next bite is on the left or the right, a little below the middle, so the path is easy to see.
  function pickSlot() {
    side = 1 - side;
    var goal = side ? 0.4 : Math.PI - 0.4;
    var best = null;
    var bestGap = Infinity;
    slots.forEach(function (slot) {
      if (slot.mode !== "ring") return;
      var gap = Math.abs(((slot.base + angle - goal + Math.PI * 3) % TAU) - Math.PI);
      if (gap < bestGap) {
        bestGap = gap;
        best = slot;
      }
    });
    return best;
  }

  function bite(slot, now) {
    if (!slot || slot.mode !== "ring" || busy()) return;
    slot.mode = "fly";
    slot.t0 = now;
    slot.sx = slot.x;
    slot.sy = slot.y;
    slot.spin = slot.x < 0 ? 1 : -1;
    slot.el.classList.add("is-flying");
    nextBite = now + FLY_MS + GAP_MS;
  }

  function chomp(name) {
    mascot.classList.remove("is-open", "is-chomp");
    void mascot.getBoundingClientRect();
    mascot.classList.add("is-chomp");
    window.setTimeout(function () {
      mascot.classList.remove("is-chomp");
    }, 1400);

    for (var i = 0; i < 7; i += 1) {
      var crumb = document.createElement("span");
      var a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      var d = 34 + Math.random() * 30;
      crumb.className = "gulp-crumb";
      crumb.style.background = CRUMBS[i % CRUMBS.length];
      crumb.style.setProperty("--dx", (Math.cos(a) * d).toFixed(1) + "px");
      crumb.style.setProperty("--dy", (Math.sin(a) * d * 0.6 + 26).toFixed(1) + "px");
      crumb.addEventListener("animationend", function (event) {
        event.target.remove();
      });
      orbit.appendChild(crumb);
    }

    bubble.textContent = "Yum, " + name + "!";
    bubble.classList.add("is-shown");
    window.clearTimeout(bubble.timer);
    bubble.timer = window.setTimeout(function () {
      bubble.classList.remove("is-shown");
    }, 1500);
  }

  // The eaten connector goes to the end of the line. The first in the line takes its place.
  function refill(slot) {
    var eaten = slot.el;
    var next = queue.shift() || eaten;
    eaten.classList.remove("is-flying");
    eaten.style.transform = "";
    eaten.style.opacity = "";
    if (next !== eaten) {
      ring.replaceChild(next, eaten);
      queueBox.appendChild(eaten);
      queue.push(eaten);
    }
    slot.el = next;
  }

  function frame(now) {
    if (!running) return;
    var dt = last ? Math.min(now - last, 64) : 16;
    last = now;
    angle += (dt / TURN_MS) * TAU;
    if (!nextBite) nextBite = now + 1000;
    if (now >= nextBite && !busy()) bite(pickSlot(), now);

    var target = null;
    var open = false;

    slots.forEach(function (slot, index) {
      var home = ringPoint(slot, now, index);

      if (slot.mode === "ring") {
        place(slot, home.x, home.y, 1, 0, 1);
      } else if (slot.mode === "fly") {
        var p = clamp((now - slot.t0) / FLY_MS);
        // First the connector shakes a little. Then the mouth pulls it in, faster and faster.
        var shake = p < 0.22 ? Math.sin(p * 90) * 9 * (1 - p / 0.22) : 0;
        var e = Math.pow(clamp((p - 0.22) / 0.78), 2.1);
        var cx = slot.sx * 0.45;
        var cy = Math.min(slot.sy, MOUTH.y) - 70;
        var u = 1 - e;
        var x = u * u * slot.sx + 2 * u * e * cx + e * e * MOUTH.x;
        var y = u * u * slot.sy + 2 * u * e * cy + e * e * MOUTH.y - (p < 0.22 ? p * 20 : 4.4 * u);
        place(slot, x, y, 1 - 0.78 * e, shake + slot.spin * e * 260, e > 0.9 ? (1 - e) * 10 : 1);
        target = { x: x, y: y, pull: e };
        open = p > 0.3;
        if (p >= 1) {
          slot.mode = "gone";
          slot.t0 = now;
          slot.el.style.opacity = "0";
          chomp(slot.el.getAttribute("data-name") || "");
        }
      } else if (slot.mode === "gone") {
        if (now - slot.t0 >= EMPTY_MS) {
          refill(slot);
          slot.mode = "spawn";
          slot.t0 = now;
        }
      } else if (slot.mode === "spawn") {
        var q = clamp((now - slot.t0) / SPAWN_MS);
        place(slot, home.x, home.y, Math.max(0, easeOutBack(q)), (1 - q) * -30, clamp(q * 3));
        if (q >= 1) slot.mode = "ring";
      }
    });

    if (open) mascot.classList.add("is-open");

    // The eyes follow the connector that it eats. With nothing to eat, they look around slowly.
    var gx = Math.cos(now / 2300) * 1.2;
    var gy = Math.sin(now / 3100) * 0.8;
    if (target) {
      var dx = target.x;
      var dy = target.y + 4;
      var d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      gx = (dx / d) * 2.6;
      gy = (dy / d) * 2.2;
    }
    eyes.x += (gx - eyes.x) * 0.15;
    eyes.y += (gy - eyes.y) * 0.15;
    look.style.transform = "translate(" + eyes.x.toFixed(2) + "px," + eyes.y.toFixed(2) + "px)";

    var goalLean = target ? Math.max(-8, Math.min(8, target.x / 18)) * (1 - target.pull * 0.6) : 0;
    lean += (goalLean - lean) * 0.12;
    body.style.transform = "rotate(" + lean.toFixed(2) + "deg)";

    window.requestAnimationFrame(frame);
  }

  function update() {
    var go = visible && !document.hidden;
    if (go === running) return;
    running = go;
    if (running) {
      last = 0;
      window.requestAnimationFrame(frame);
    }
  }

  // A click on a connector feeds it to the mascot. A click on the mascot makes it eat now.
  ring.addEventListener("click", function (event) {
    var el = event.target.closest(".orbit-item");
    var slot = slots.filter(function (s) {
      return s.el === el;
    })[0];
    bite(slot, performance.now());
  });
  body.addEventListener("click", function () {
    bite(pickSlot(), performance.now());
  });

  document.addEventListener("visibilitychange", update);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[entries.length - 1].isIntersecting;
      update();
    }).observe(orbit);
  }
  update();
})();

// "How it works", in the style of multiplier.ai/architecture. One large map stays
// on the screen. As the page scrolls, a camera moves and zooms over 3 stops: the
// tools, the AI apps, the permissions. Then it zooms out to show the whole map.
// Each part draws itself. The camera holds at
// each stop and moves between them, so the scroll feels firm. Scrolling up plays it back.
(function () {
  "use strict";

  var flow = document.querySelector("[data-flow]");
  if (!flow || !window.requestAnimationFrame) return;
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var track = flow.querySelector("[data-flow-track]");
  var map = flow.querySelector(".flow-map");
  var world = flow.querySelector("[data-flow-world]");
  var svg = flow.querySelector("[data-flow-lines]");
  var hub = flow.querySelector("[data-flow-hub]");
  var mascot = hub.querySelector(".mascot");
  var tools = Array.prototype.slice.call(flow.querySelectorAll("[data-flow-tools] > li"));
  var rows = Array.prototype.slice.call(flow.querySelectorAll("[data-flow-agents] > li"));
  var agents = rows.map(function (row) {
    return row.querySelector(".flow-agent");
  });
  var perms = rows.map(function (row) {
    return row.querySelector(".flow-perm");
  });
  var copy = Array.prototype.slice.call(flow.querySelectorAll("[data-flow-copy] > li"));
  var NS = "http://www.w3.org/2000/svg";
  var stops = copy.length - 1;
  // The last half step is the zoom out to the whole map.
  var END = stops + 1.5;
  var cameras = [];
  var target = 0;
  var shown = stops;
  var cur = 0;
  var running = false;

  // Each node knows its place in its list, so the nodes come in one after the other.
  tools.forEach(function (el, index) {
    el.style.setProperty("--i", String(index));
  });
  agents.concat(perms).forEach(function (el, index) {
    el.style.setProperty("--i", String(index % agents.length));
  });

  /** The box of an element in the coordinates of the map, before the camera. */
  function box(el) {
    var x = 0;
    var y = 0;
    for (var n = el; n && n !== world; n = n.offsetParent) {
      x += n.offsetLeft;
      y += n.offsetTop;
    }
    return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
  }

  function union(list, pad) {
    var x1 = Infinity;
    var y1 = Infinity;
    var x2 = -Infinity;
    var y2 = -Infinity;
    list.forEach(function (b) {
      x1 = Math.min(x1, b.x);
      y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.w);
      y2 = Math.max(y2, b.y + b.h);
    });
    return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
  }

  // Each line has a second path on top: dots of data that move along it, each at its own speed.
  function line(a, b, kind) {
    var dx = (b.x - a.x) / 2;
    var d = "M" + a.x + " " + a.y + "C" + (a.x + dx) + " " + a.y + " " + (b.x - dx) + " " + b.y + " " + b.x + " " + b.y;
    ["flow-line flow-line-", "flow-pulse flow-pulse-"].forEach(function (base, index) {
      var path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("pathLength", "1");
      path.setAttribute("class", base + kind);
      if (index === 1) {
        path.style.setProperty("--speed", (1.8 + Math.random() * 1.6).toFixed(2) + "s");
        path.style.setProperty("--delay", (-Math.random() * 3).toFixed(2) + "s");
      }
      svg.appendChild(path);
    });
  }

  // The lines, and the camera views: the tools, the AI apps, the permissions, and last the whole map.
  function layout() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute("width", String(world.offsetWidth));
    svg.setAttribute("height", String(world.offsetHeight));
    var h = box(hub);
    var t = [box(tools[0].parentNode.parentNode)];
    var aiGroup = box(agents[0].parentNode.parentNode.parentNode);
    var a = agents.map(box);
    var p = perms.map(box);
    tools.forEach(function (el) {
      var b = box(el);
      line({ x: b.x + b.w + 4, y: b.y + b.h / 2 }, { x: h.x, y: h.y + h.h / 2 }, "in");
    });
    a.forEach(function (b, index) {
      line({ x: h.x + h.w, y: h.y + h.h / 2 }, { x: b.x, y: b.y + b.h / 2 }, "out");
      line({ x: b.x + b.w, y: b.y + b.h / 2 }, { x: p[index].x, y: p[index].y + p[index].h / 2 }, "perm");
    });
    var regions = [
      union(t.concat([h]), 30),
      union([h, aiGroup], 30),
      union([h, aiGroup].concat(p), 40),
      union(t.concat([h, aiGroup], p), 60),
    ];
    var w = map.clientWidth;
    var hh = map.clientHeight;
    cameras = regions.map(function (r) {
      var zoom = Math.min(w / r.w, hh / r.h, 1.5);
      return { zoom: zoom, x: w / 2 - (r.x + r.w / 2) * zoom, y: hh / 2 - (r.y + r.h / 2) * zoom };
    });
  }

  function clamp(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // Hold at each stop, move between stops: 20% hold, 60% move, 20% hold.
  function ease(t) {
    var u = clamp((t - 0.2) / 0.6);
    return u * u * (3 - 2 * u);
  }

  // p goes from 0 to END. Step i has the part from i to i + 1: first the part of the map draws
  // itself, then the camera moves on. After the last step the camera zooms out to the whole map.
  function place(p) {
    var c = Math.min(cameras.length - 1, Math.max(0, p - 0.5));
    var i = Math.min(cameras.length - 2, Math.floor(c));
    var e = ease(c - i);
    var from = cameras[i];
    var to = cameras[i + 1];
    var zoom = from.zoom + (to.zoom - from.zoom) * e;
    var x = from.x + (to.x - from.x) * e;
    var y = from.y + (to.y - from.y) * e;
    world.style.transform = "translate(" + x.toFixed(1) + "px," + y.toFixed(1) + "px) scale(" + zoom.toFixed(4) + ")";
    world.style.setProperty("--a", clamp((p - 0.05) / 0.5).toFixed(3));
    world.style.setProperty("--b", clamp((p - 1.05) / 0.5).toFixed(3));
    world.style.setProperty("--c", clamp((p - 2.05) / 0.5).toFixed(3));
    world.style.setProperty("--d", clamp((p - 3.05) / 0.3).toFixed(3));
    var now = Math.min(stops, Math.floor(p));
    var done = p >= 3.2;
    if (now !== shown || done !== world.done) {
      if ((now > shown && now === 0) || (done && !world.done)) chomp();
      shown = now;
      world.done = done;
      copy.forEach(function (li, index) {
        li.classList.toggle("is-on", index === now);
      });
    }
  }

  function chomp() {
    mascot.classList.remove("is-chomp");
    void mascot.getBoundingClientRect();
    mascot.classList.add("is-chomp");
    window.setTimeout(function () {
      mascot.classList.remove("is-chomp");
    }, 1400);
  }

  function read() {
    var r = track.getBoundingClientRect();
    var room = r.height - window.innerHeight;
    target = room > 0 ? clamp(-r.top / room) * END : END;
  }

  // The camera follows the scroll with a short delay, so it glides and does not jump.
  function frame() {
    cur += (target - cur) * 0.16;
    if (Math.abs(target - cur) < 0.001) cur = target;
    place(cur);
    if (cur !== target) window.requestAnimationFrame(frame);
    else running = false;
  }

  function wake() {
    read();
    if (!running) {
      running = true;
      window.requestAnimationFrame(frame);
    }
  }

  if (still) {
    layout();
    place(END);
    window.addEventListener("resize", function () {
      layout();
      place(END);
    });
    return;
  }

  flow.classList.add("is-live");
  layout();
  read();
  cur = target;
  place(cur);
  window.addEventListener("scroll", wake, { passive: true });
  window.addEventListener("resize", function () {
    layout();
    wake();
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      layout();
      place(cur);
    });
  }
})();
