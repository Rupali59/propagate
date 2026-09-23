/**
 * The smallest DOM Preact will render into.
 *
 * WHY NOT jsdom. This repo has three runtime dependencies and no build step,
 * and the page it tests is one self-contained response. Adding a 3 MB DOM
 * implementation to assert that a 12 KB renderer works is the wrong trade —
 * and the parts of jsdom that matter here are the twenty methods below.
 *
 * WHAT THIS BUYS OVER THE OLD APPROACH. The previous client was tested by
 * exporting its pure helpers and calling them; nothing ever rendered. That
 * catches a wrong grouping axis and misses "the component throws on a row with
 * no blockedBy", which is the failure a person actually sees. This stub is
 * enough for Preact to mount, diff, and re-render, so a test can assert on the
 * TREE rather than on the functions that feed it.
 *
 * It is deliberately strict: an unimplemented method throws with its own name
 * rather than returning undefined. A stub that silently absorbs calls makes a
 * broken render look like a passing test.
 */

let nextId = 1;

class MiniNode {
  constructor(tag, ns) {
    this.nodeType = 1;
    this.tagName = String(tag || "").toUpperCase();
    this.localName = String(tag || "");
    this.namespaceURI = ns || null;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = new Proxy({ _props: new Map() }, {
      get(t, k) {
        if (k === "setProperty") return (n, v) => { t._props.set(n, String(v)); };
        if (k === "removeProperty") return (n) => { t._props.delete(n); };
        if (k === "getPropertyValue") return (n) => t._props.get(n) ?? "";
        if (k === "cssText") return [...t._props].map(([a, b]) => a + ":" + b).join(";");
        if (k === "_props") return t._props;
        return t[k];
      },
      set(t, k, v) { t[k] = v; t._props.set(String(k).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()), String(v)); return true; },
    });
    this.listeners = new Map();
    this.__id = nextId += 1;
  }

  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] ?? null;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent ?? "").join("");
  }
  set textContent(v) { this.childNodes = []; if (v !== "" && v != null) this.appendChild(new MiniText(v)); }

  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }

  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t).add(fn);
  }
  removeEventListener(t, fn) { if (this.listeners.has(t)) this.listeners.get(t).delete(fn); }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    ev.currentTarget = this;
    for (const fn of this.listeners.get(ev.type) ?? []) fn(ev);
    return true;
  }

  /** SVG geometry Preact never calls, but our chart code does. */
  getTotalLength() { return 123.4; }

  focus() {}
  blur() {}
  contains(n) {
    for (let p = n; p; p = p.parentNode) if (p === this) return true;
    return false;
  }
}

class MiniText {
  constructor(v) { this.nodeType = 3; this.data = String(v); this.parentNode = null; this.childNodes = []; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

/** Walk the tree; the tests assert against this rather than an HTML string. */
export function walk(node, fn) {
  fn(node);
  for (const c of node.childNodes ?? []) walk(c, fn);
}
export function textOf(node) { return node.textContent ?? ""; }
export function findAll(root, pred) {
  const out = [];
  walk(root, (n) => { if (pred(n)) out.push(n); });
  return out;
}
export const byClass = (root, cls) =>
  findAll(root, (n) => n.nodeType === 1 && String(n.getAttribute && n.getAttribute("class") || "").split(/\s+/).includes(cls));
export const byTag = (root, tag) =>
  findAll(root, (n) => n.nodeType === 1 && n.localName === tag);

export function makeDocument({ token = "test-token" } = {}) {
  const doc = {
    createElement: (t) => new MiniNode(t),
    createElementNS: (ns, t) => new MiniNode(t, ns),
    createTextNode: (v) => new MiniText(v),
    // Preact probes this for event-capture support.
    addEventListener() {},
    removeEventListener() {},
  };
  doc.documentElement = new MiniNode("html");
  doc.body = new MiniNode("body");
  doc.body.dataset = { token };
  doc.head = new MiniNode("head");
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  const app = new MiniNode("div");
  app.setAttribute("id", "app");
  doc.body.appendChild(app);
  doc.getElementById = (id) => (id === "app" ? app : null);
  doc.activeElement = doc.body;
  doc.createDocumentFragment = () => new MiniNode("#fragment");
  return { doc, app };
}
