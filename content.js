(() => {
  if (globalThis.__superScreenshotReady) return;
  globalThis.__superScreenshotReady = true;

  const STYLE_ID = "__ss-capture-style";
  const state = {
    prepared: false,
    scrollX: 0,
    scrollY: 0,
    htmlOverflow: "",
    bodyOverflow: "",
    htmlScrollBehavior: "",
    hidden: [],
    root: null,
  };

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findScrollRoot() {
    const doc = document.documentElement;
    const body = document.body;
    const windowHeight = window.innerHeight;
    const docHeight = Math.max(
      doc.scrollHeight,
      body ? body.scrollHeight : 0,
      doc.offsetHeight,
      body ? body.offsetHeight : 0
    );

    if (docHeight > windowHeight + 8) {
      return { isWindow: true, el: null };
    }

    let best = null;
    let bestOverflow = 0;
    const nodes = body ? body.querySelectorAll("*") : [];
    for (const el of nodes) {
      const style = getComputedStyle(el);
      const overflowY = style.overflowY;
      if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") continue;
      const extra = el.scrollHeight - el.clientHeight;
      if (extra < 80) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) continue;
      const area = Math.min(rect.width, window.innerWidth) * Math.min(rect.height, windowHeight);
      const score = extra * area;
      if (score > bestOverflow) {
        bestOverflow = score;
        best = el;
      }
    }

    if (best) return { isWindow: false, el: best };
    return { isWindow: true, el: null };
  }

  function currentScroll() {
    if (state.root && !state.root.isWindow && state.root.el) {
      return { x: state.root.el.scrollLeft, y: state.root.el.scrollTop };
    }
    return { x: window.scrollX, y: window.scrollY };
  }

  function metrics() {
    const doc = document.documentElement;
    const body = document.body;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const root = state.root || findScrollRoot();

    let documentHeight;
    let documentWidth;
    if (!root.isWindow && root.el) {
      documentHeight = root.el.scrollHeight;
      documentWidth = Math.min(root.el.clientWidth, windowWidth);
    } else {
      documentHeight = Math.max(
        doc.scrollHeight,
        body ? body.scrollHeight : 0,
        doc.offsetHeight,
        body ? body.offsetHeight : 0,
        windowHeight
      );
      documentWidth = windowWidth;
    }

    const scroll = currentScroll();
    return {
      windowWidth,
      windowHeight,
      documentWidth,
      documentHeight,
      scrollX: scroll.x,
      scrollY: scroll.y,
      dpr: window.devicePixelRatio || 1,
      usesInnerScroller: Boolean(root && !root.isWindow),
    };
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
        background: transparent !important;
      }
      html, body { scrollbar-width: none !important; }
      html { scroll-behavior: auto !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function prepare() {
    const doc = document.documentElement;
    const body = document.body;
    state.root = findScrollRoot();
    const scroll = currentScroll();
    state.scrollX = scroll.x;
    state.scrollY = scroll.y;
    state.htmlOverflow = doc.style.overflow;
    state.bodyOverflow = body ? body.style.overflow : "";
    state.htmlScrollBehavior = doc.style.scrollBehavior;
    state.hidden = [];
    state.prepared = true;
    doc.style.scrollBehavior = "auto";
    ensureStyle();
    return metrics();
  }

  function scrollToPos(x, y) {
    const root = state.root || findScrollRoot();
    if (!root.isWindow && root.el) {
      try {
        root.el.scrollTo({ left: x, top: y, behavior: "instant" });
      } catch {
        root.el.scrollTop = y;
        root.el.scrollLeft = x;
      }
      if (Math.abs(root.el.scrollTop - y) > 1) root.el.scrollTop = y;
      if (Math.abs(root.el.scrollLeft - x) > 1) root.el.scrollLeft = x;
    } else {
      try {
        window.scrollTo({ left: x, top: y, behavior: "instant" });
      } catch {
        window.scrollTo(x, y);
      }
      if (Math.abs(window.scrollY - y) > 1) window.scrollTo(x, y);
    }
    return currentScroll();
  }

  async function waitForPaint() {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const images = [...document.images].filter((img) => {
      if (img.complete) return false;
      const rect = img.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    });
    if (images.length) {
      await Promise.race([
        Promise.all(
          images.map((img) => {
            if (typeof img.decode === "function") return img.decode().catch(() => {});
            return new Promise((resolve) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener("error", resolve, { once: true });
            });
          })
        ),
        delay(500),
      ]);
    }
    await delay(60);
    return currentScroll();
  }

  function hideFixed() {
    const body = document.body;
    if (!body) return { hidden: 0 };
    const next = [];
    for (const el of body.querySelectorAll("*")) {
      if (el.id === STYLE_ID) continue;
      const style = getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9) continue;
      next.push({
        el,
        visibility: el.style.visibility,
        important: el.style.getPropertyPriority("visibility"),
      });
      el.style.setProperty("visibility", "hidden", "important");
    }
    state.hidden = next;
    return { hidden: next.length };
  }

  function restore() {
    for (const item of state.hidden) {
      if (!item.el) continue;
      if (item.visibility) {
        item.el.style.setProperty("visibility", item.visibility, item.important || "");
      } else {
        item.el.style.removeProperty("visibility");
      }
    }
    state.hidden = [];
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    if (state.prepared) {
      document.documentElement.style.overflow = state.htmlOverflow;
      document.documentElement.style.scrollBehavior = state.htmlScrollBehavior;
      if (document.body) document.body.style.overflow = state.bodyOverflow;
      scrollToPos(state.scrollX, state.scrollY);
      state.prepared = false;
    }
    return { restored: true };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.ns !== "ss") return;
    Promise.resolve()
      .then(() => {
        switch (msg.op) {
          case "prepare":
            return prepare();
          case "metrics":
            return metrics();
          case "scroll":
            return scrollToPos(msg.x ?? 0, msg.y ?? 0);
          case "wait":
            return waitForPaint();
          case "hideFixed":
            return hideFixed();
          case "restore":
            return restore();
          default:
            throw new Error(`Unknown op: ${msg.op}`);
        }
      })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  });
})();
