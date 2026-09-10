// Small DOM adapter for offline vanilla-script interaction tests. This models
// only the DOM APIs Splitty uses; browser layout, navigation and native keyboard
// behavior still need browser verification. It never downloads script assets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const decode = (text) => String(text).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => {
  if (name.startsWith("#")) return String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
  return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }[name.toLowerCase()];
});
const dataName = (name) => "data-" + name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase(); this.ownerDocument = document;
    this.attributes = new Map(); this.childNodes = []; this.listeners = new Map();
    this.style = { setProperty() {} };
    this.dataset = new Proxy({}, { get: (_, name) => this.getAttribute(dataName(name)) ?? undefined, set: (_, name, value) => { this.setAttribute(dataName(name), value); return true; } });
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => { const enabled = force ?? !this.classList.contains(name); this.classList[enabled ? "add" : "remove"](name); return enabled; },
    };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", value); }
  get className() { return this.getAttribute("class") || ""; }
  set className(value) { this.setAttribute("class", value); }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(value) { value ? this.setAttribute("disabled", "") : this.removeAttribute("disabled"); }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(value) { value ? this.setAttribute("hidden", "") : this.removeAttribute("hidden"); }
  get href() { return this.getAttribute("href") || ""; }
  set href(value) { this.setAttribute("href", value); }
  get value() { return this._value ?? this.getAttribute("value") ?? ""; }
  set value(value) { this._value = String(value); }
  get children() { return this.childNodes.filter((node) => node instanceof Element); }
  get childElementCount() { return this.children.length; }
  appendChild(node) { node.parentElement = this; this.childNodes.push(node); return node; }
  append(...nodes) { for (const node of nodes) this.appendChild(typeof node === "string" ? { textContent: node } : node); }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.childNodes = this.parentElement.childNodes.filter((node) => node !== this); }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(text) { this.replaceChildren(String(text)); }
  set innerHTML(html) { this.childNodes = []; parseInto(String(html), this); }
  get innerHTML() { return this.childNodes.map((node) => node instanceof Element ? `<${node.tagName.toLowerCase()}>${node.innerHTML}</${node.tagName.toLowerCase()}>` : node.textContent).join(""); }
  matches(selector) {
    if (selector === "*") return true;
    const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const [, id] of selector.matchAll(/#([\w-]+)/g)) if (this.id !== id) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
    for (const [, name, quote, value] of selector.matchAll(/\[([\w-]+)(?:=(["']?)(.*?)\2)?\]/g)) {
      if (!this.hasAttribute(name) || (value !== undefined && this.getAttribute(name) !== value)) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const matches = [];
    const selectors = selector.split(/\s*,\s*/);
    const visit = (node) => {
      for (const child of node.children) {
        if (selectors.some((choice) => {
          const parts = choice.trim().split(/\s+/); let ancestor = child;
          if (!ancestor.matches(parts.pop())) return false;
          while (parts.length) {
            const parentSelector = parts.pop(); ancestor = ancestor.parentElement;
            while (ancestor && !ancestor.matches(parentSelector)) ancestor = ancestor.parentElement;
            if (!ancestor) return false;
          }
          return true;
        })) matches.push(child);
        visit(child);
      }
    };
    visit(this); return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  addEventListener(type, listener) { const listeners = this.listeners.get(type) || []; listeners.push(listener); this.listeners.set(type, listeners); }
  dispatchEvent(event) {
    event.target ||= this; event.currentTarget = this;
    event.preventDefault ||= () => {}; event.stopPropagation ||= () => {};
    this["on" + event.type]?.(event);
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: "click" }); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
}

function parseInto(html, parent) {
  const stack = [parent];
  for (const token of html.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]*>|[^<]+/g) || []) {
    if (/^<!/.test(token)) continue;
    if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
    if (!token.startsWith("<")) { stack.at(-1).append(decode(token)); continue; }
    const tag = token.match(/^<([\w-]+)/)?.[1];
    if (!tag) throw new Error("Unsupported HTML token: " + token);
    const node = new Element(tag, parent.ownerDocument);
    const attrs = token.slice(tag.length + 1).replace(/\/?\s*>$/, "");
    for (const [, name, double, single, bare] of attrs.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) node.setAttribute(name, decode(double ?? single ?? bare ?? ""));
    stack.at(-1).appendChild(node);
    if (!voidTags.has(tag.toLowerCase()) && !token.endsWith("/>")) stack.push(node);
  }
}

export function loadPage(file, { storage = {}, allowBillBootstrap = false, beforeScripts } = {}) {
  const html = readFileSync(new URL("../public/" + file, import.meta.url), "utf8");
  const effects = [], sockets = [];
  const forbidden = (kind) => (...args) => { effects.push({ kind, args }); throw new Error("Blocked " + kind + " in offline UI test"); };
  const document = new Element("document"); document.ownerDocument = document;
  document.createElement = (tag) => new Element(tag, document);
  document.createTextNode = (text) => ({ textContent: String(text) });
  document.getElementById = (id) => document.querySelector("#" + id);
  Object.defineProperty(document, "cookie", { get: forbidden("cookie read"), set: forbidden("cookie write") });
  parseInto(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ""), document);
  document.head = document.querySelector("head"); document.body = document.querySelector("body");
  const localStorage = allowBillBootstrap ? {
    getItem: (key) => storage[key] ?? null,
    setItem: (key, value) => { storage[key] = String(value); },
    removeItem: (key) => { delete storage[key]; },
  } : { getItem: forbidden("storage read"), setItem: forbidden("storage write"), removeItem: forbidden("storage remove"), clear: forbidden("storage clear") };
  const url = new URL(allowBillBootstrap ? "https://splitty.test/b/" + "a".repeat(22) : "https://splitty.test/demo");
  class FakeWebSocket {
    constructor(address) {
      if (!allowBillBootstrap) return forbidden("WebSocket")(address);
      assert.equal(address, "wss://splitty.test/api/bills/" + "a".repeat(22) + "/ws");
      this.readyState = 1; this.sent = []; sockets.push(this);
    }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
  }
  let timerId = 0;
  const context = vm.createContext({
    document, location: { origin: url.origin, pathname: url.pathname, protocol: url.protocol, host: url.host, hash: "", search: "" },
    history: { replaceState() {} }, localStorage, sessionStorage: localStorage,
    navigator: { sendBeacon: forbidden("beacon"), clipboard: { writeText: forbidden("clipboard write") } },
    fetch: allowBillBootstrap ? async (address) => {
      assert.equal(address, "/api/bills/" + "a".repeat(22)); return { ok: true, json: async () => ({}) };
    } : forbidden("fetch"),
    WebSocket: FakeWebSocket, XMLHttpRequest: forbidden("XMLHttpRequest"), EventSource: forbidden("EventSource"),
    setTimeout: () => ++timerId, clearTimeout() {}, setInterval: () => ++timerId, clearInterval() {},
    URL, URLSearchParams, AbortController, structuredClone, console,
    addEventListener() {}, prompt: forbidden("prompt"),
  });
  context.window = context;
  beforeScripts?.(context);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const [, attrs, inline] of scripts) {
    const src = attrs.match(/\bsrc=["']([^"']+)["']/)?.[1];
    if (src) assert.match(src, /^\/[\w-]+\.js$/, "Only bundled scripts may load in this harness");
    const source = src ? readFileSync(new URL("../public" + src, import.meta.url), "utf8") : inline;
    vm.runInContext(source, context, { filename: src || file, timeout: 1000 });
  }
  return { html, context, document, effects, sockets, storage, run: (code) => vm.runInContext(code, context), element: (id) => {
    const element = document.getElementById(id); assert.ok(element, "Element exists: " + id); return element;
  } };
}
