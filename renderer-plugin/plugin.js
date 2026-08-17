import React from "react";
import {
  host,
  atom,
  useValue,
  Button,
  Input,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Separator,
  Badge,
  Loader,
  EmptyState,
  ErrorState,
  Codicon,
  STATUSBAR_AREAS,
  PALETTE_AREA,
} from "@hermes/plugin-sdk";

const { useEffect, useState, useRef, useCallback } = React;

const FENCE = "```";
const PREFIX = "> ";
const TERM_CAP = 200;
const STORAGE_KEY = "settings.v1";
const DEFAULT_TEMPLATE = [
  `Define "{term}" for a knowledgeable general audience.`,
  ``,
  `You have web-search context below. Use ONLY the URLs supplied there as`,
  `citations. NEVER invent URLs — if the search returned nothing usable,`,
  `omit Sources entirely and say "no definitive online source found".`,
  `If the search returned no images, do NOT embed a markdown image — a`,
  `fabricated URL is worse than no image.`,
  ``,
  `Format (markdown):`,
  ``,
  `**{term}** — one-sentence definition.`,
  `Then, only when useful: 2-3 short "Examples" bullets and one "Also known as" line.`,
  ``,
  `Use fenced code blocks with a language tag for code (e.g. \`\`\`js, \`\`\`python).`,
  `For images, embed ![caption](url) ONLY when the URL is one of the`,
  `search results supplied in Web-search context below. Copy that exact URL.`,
  `Cite sources in-place: when search returned a real result, write`,
  `[Source Name](url) next to the claim it supports — use the exact URL`,
  `from the search context. Do NOT paraphrase or hand-craft URLs.`,
  ``,
  `Writing rules (no AI slop):`,
  `- Prefer concrete nouns over abstractions.`,
  `- No filler ("In today's world...", "It's important to note...", "Let's dive in...").`,
  `- No em-dash overuse. No "delve", "leverage", "robust", "seamless", "cutting-edge".`,
  `- No breathless affirmations or sycophantic tone. State the thing, then stop.`,
  `- Short sentences. If a sentence crosses two clauses, split it.`,
  `- Plain English. If a 6-letter word replaces a 14-letter one, use it.`,
  ``,
  `Keep the whole reply under ~180 words. No preamble, no closing remarks.`,
].join("\n");

const SETTINGS_DEFAULTS = {
  providers: [],
  template: DEFAULT_TEMPLATE,
  transport: "direct",
  search: { enabled: false, preset: "standard", apiKey: "", endpoint: "", maxResults: 5 },
  last: { providerId: "", model: "" },
};

let _storage = null;
const settingsAtom = atom(SETTINGS_DEFAULTS);

function loadSettings(storage) {
  try {
    const raw = storage.get(STORAGE_KEY);
    if (!raw) return SETTINGS_DEFAULTS;
    const parsed = JSON.parse(raw);
    if (parsed.search && parsed.search.preset && !["standard", "custom", "off"].includes(parsed.search.preset)) {
      parsed.search = { ...parsed.search, preset: "standard", apiKey: "" };
    }
    return {
      ...SETTINGS_DEFAULTS,
      ...parsed,
      search: { ...SETTINGS_DEFAULTS.search, ...(parsed.search || {}) },
      last: { ...SETTINGS_DEFAULTS.last, ...(parsed.last || {}) },
      providers: Array.isArray(parsed.providers) ? parsed.providers : SETTINGS_DEFAULTS.providers,
    };
  } catch {
    return SETTINGS_DEFAULTS;
  }
}

function patchSettings(patch) {
  const next = { ...settingsAtom.get(), ...patch };
  settingsAtom.set(next);
  if (_storage) {
    try { _storage.set(STORAGE_KEY, JSON.stringify(next)); } catch { }
  }
  return next;
}

function inAssistant(node) {
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  return !!(el && el.closest && el.closest('[data-role="assistant"]'));
}

function currentSelectionFragment() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  if (!(inAssistant(sel.anchorNode) || inAssistant(sel.focusNode))) return null;
  return sel.getRangeAt(0).cloneContents();
}

function serializeLead(node, depth, ordered) {
  return Array.from(node.childNodes)
    .filter((c) => !(c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")))
    .map((c) => serializeNode(c, depth, ordered))
    .join("");
}

function serializeListItems(listEl, depth, ordered) {
  let n = 0;
  const items = Array.from(listEl.children)
    .filter((c) => c.tagName === "LI")
    .map((li) => {
      n += 1;
      const marker = ordered ? n + ". " : "- ";
      const indent = "  ".repeat(depth);
      const lead = serializeLead(li, depth, ordered).replace(/\s+$/, "");
      const nested = Array.from(li.childNodes)
        .filter((c) => c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL"))
        .map((c) => serializeNode(c, depth + 1, c.tagName === "OL"))
        .join("");
      const firstLine = indent + marker + lead;
      return nested ? firstLine + "\n" + nested.replace(/\n+$/, "") : firstLine;
    });
  return items.join("\n") + "\n";
}

function serializeNode(node, depth, ordered) {
  if (node.nodeType === 3) {
    return (node.textContent || "").replace(/[ \t\r\n]+/g, " ");
  }
  if (node.nodeType !== 1) return "";

  const tag = node.tagName;
  const inline = () =>
    Array.from(node.childNodes).map((c) => serializeNode(c, depth, ordered)).join("");

  switch (tag) {
    case "BR":
      return "\n";
    case "B":
    case "STRONG":
      return "**" + inline() + "**";
    case "I":
    case "EM":
    case "U":
      return "*" + inline() + "*";
    case "CODE": {
      if (node.closest && node.closest("PRE")) return inline();
      return "`" + inline() + "`";
    }
    case "A": {
      const href = (node.getAttribute && node.getAttribute("href")) || "";
      return "[" + inline() + "](" + href + ")";
    }
    case "IMG": {
      const alt = (node.getAttribute && node.getAttribute("alt")) || "";
      const src = (node.getAttribute && node.getAttribute("src")) || "";
      return "![" + alt + "](" + src + ")";
    }
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const lvl = parseInt(tag[1], 10);
      return "#".repeat(lvl) + " " + inline().trim() + "\n";
    }
    case "P":
    case "DIV":
      return inline() + "\n";
    case "PRE":
      return FENCE + "\n" + (node.textContent || "") + "\n" + FENCE + "\n";
    case "BLOCKQUOTE":
      return (
        inline()
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => "> " + l)
          .join("\n") + "\n"
      );
    case "UL":
    case "OL":
      return serializeListItems(node, depth, tag === "OL") + "\n";
    default:
      return inline();
  }
}

function serializeFragment(frag) {
  const parts = Array.from(frag.childNodes).map((n) => serializeNode(n, 0, false));
  let md = parts.join("");
  md = md
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
  return md;
}

function buildQuote(md) {
  const body = md.replace(/\s+$/, "");
  const content = body
    .split("\n")
    .map((l) => PREFIX + l)
    .join("\n");
  return PREFIX + FENCE + "\n" + content + "\n" + PREFIX + FENCE + "\n";
}

const RICH_INPUT_SLOT = "composer-rich-input";

function appendDraftNewline() {
  const editor = document.querySelector(`[data-slot="${RICH_INPUT_SLOT}"]`);
  if (!editor) return;
  try { editor.focus({ preventScroll: true }); } catch { }
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
  let ok = false;
  try { ok = document.execCommand("insertLineBreak"); } catch { ok = false; }
  if (!ok) {
    const br = document.createElement("BR");
    range.deleteContents();
    range.insertNode(br);
    const after = document.createRange();
    after.setStartAfter(br);
    after.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(after);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }
}

function insertQuoteIntoComposer(quoted) {
  window.dispatchEvent(
    new CustomEvent("hermes:composer-insert", {
      detail: { mode: "block", target: "main", text: quoted },
    })
  );
  window.dispatchEvent(
    new CustomEvent("hermes:composer-focus", { detail: { target: "main" } })
  );
  window.requestAnimationFrame(() => window.setTimeout(appendDraftNewline, 0));
}

const termAtom = atom("");
const requestIdAtom = atom(0);
const panelOpenAtom = atom(false);

function capTerm(text) {
  return (text || "").replace(/\s+/g, " ").trim().slice(0, TERM_CAP);
}

function defineSelection() {
  const sel = window.getSelection && window.getSelection();
  const text = sel ? sel.toString() : "";
  const term = capTerm(text);
  if (!term) return false;
  termAtom.set(term);
  panelOpenAtom.set(true);
  requestIdAtom.set(requestIdAtom.get() + 1);
  try { sel.removeAllRanges(); } catch { }
  return true;
}

function inlineImage(s) {
  const src = (s && s.image) || "";
  if (!src) return null;
  return [
    React.createElement(
      "div",
      {
        key: "img-frame",
        style: {
          display: "block",
          width: "100%",
          minHeight: "120px",
          borderRadius: "0.375rem",
          border: "1px solid var(--ui-stroke-secondary)",
          background: "var(--muted)",
          marginBottom: "0.125rem",
          overflow: "hidden",
          textAlign: "center",
        },
      },
      React.createElement("img", {
        key: "img",
        src,
        alt: s.title || "Search image",
        loading: "eager",
        decoding: "sync",
        style: {
          display: "block",
          width: "100%",
          maxWidth: "100%",
          height: "auto",
          minHeight: "120px",
          objectFit: "contain",
        },
      })
    ),
    withImgCaption(s),
  ];
}

function withImgCaption(s) {
  return React.createElement(
    "div",
    {
      key: "img-caption",
      style: { fontSize: "0.6875rem", color: "var(--ui-text-tertiary)", marginBottom: "0.25rem", wordBreak: "break-all" },
    },
    "Image: ",
    s && s.url
      ? React.createElement(
          "a",
          {
            href: s.url,
            target: "_blank",
            rel: "noreferrer",
            className: "insight-link",
            style: {
              color: "var(--ui-accent)",
              textDecoration: "underline",
              textDecorationThickness: "1px",
              textUnderlineOffset: "2px",
            },
          },
          s.title || s.url
        )
      : s && s.title
  );
}

function renderInline(text, keyBase) {
  const nodes = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|!\[[^\]]*\]\([^)]*\)|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      nodes.push(React.createElement("span", { key: keyBase + "-" + i++ }, text.slice(last, m.index)));
    }
    const tok = m[0];
    if (tok.startsWith("**")) {
      nodes.push(React.createElement("strong", { key: keyBase + "-" + i++ }, tok.slice(2, -2)));
    } else if (tok.startsWith("`")) {
      nodes.push(React.createElement("code", { key: keyBase + "-" + i++ }, tok.slice(1, -1)));
    } else if (tok.startsWith("![")) {
      const mm = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(tok);
      if (mm) {
        const imgSrc = mm[2] || "";
        const imgAlt = mm[1] || "image";
        nodes.push(
          React.createElement(
            "div",
            {
              key: keyBase + "-" + i++,
              style: {
                display: "block",
                width: "100%",
                minHeight: "160px",
                maxHeight: "320px",
                borderRadius: "0.375rem",
                border: "1px solid var(--ui-stroke-secondary)",
                background: "var(--muted)",
                margin: "6px 0",
                overflow: "hidden",
                textAlign: "center",
                position: "relative",
              },
            },
            React.createElement("img", {
              alt: imgAlt,
              src: imgSrc,
              loading: "eager",
              decoding: "sync",
              style: {
                display: "inline-block",
                width: "auto",
                maxWidth: "100%",
                height: "auto",
                maxHeight: "320px",
                objectFit: "contain",
                margin: "0 auto",
              },
              onError: (e) => {
                try {
                  e.target.style.display = "none";
                  const sib = e.target.nextSibling;
                  if (sib && sib.classList) sib.classList.remove("insight-hidden");
                } catch (z) { }
              },
            }),
            React.createElement(
              "div",
              {
                className: "insight-hidden",
                style: {
                  padding: "12px 8px",
                  fontSize: "0.75rem",
                  color: "var(--ui-text-tertiary)",
                  textAlign: "center",
                  lineHeight: 1.4,
                },
              },
              React.createElement("div", { style: { fontWeight: 600, marginBottom: "4px" } }, "image unavailable"),
              React.createElement("div", { style: { wordBreak: "break-all" } }, imgAlt),
              imgSrc
                ? React.createElement(
                    "a",
                    {
                      href: imgSrc,
                      target: "_blank",
                      rel: "noreferrer",
                      className: "insight-link",
                      style: {
                        color: "var(--ui-accent)",
                        textDecoration: "underline",
                        textDecorationThickness: "1px",
                        textUnderlineOffset: "2px",
                      },
                    },
                    "(open source)"
                  )
                : null
            )
          )
        );
      } else {
        nodes.push(React.createElement("span", { key: keyBase + "-" + i++ }, tok));
      }
    } else {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (mm) {
        nodes.push(React.createElement("a", {
          key: keyBase + "-" + i++,
          href: mm[2],
          target: "_blank",
          rel: "noreferrer",
          className: "insight-link",
          style: {
            color: "var(--ui-accent)",
            textDecoration: "underline",
            textDecorationThickness: "1px",
            textUnderlineOffset: "2px",
          },
        }, mm[1]));
      } else {
        nodes.push(React.createElement("span", { key: keyBase + "-" + i++ }, tok));
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(React.createElement("span", { key: keyBase + "-" + i++ }, text.slice(last)));
  return nodes;
}

function highlightCode(code, lang) {
  const norm = { py: "py", python: "py", js: "js", javascript: "js", ts: "ts", typescript: "ts",
    rb: "rb", ruby: "rb", go: "go", golang: "go", rs: "rs", rust: "rs",
    java: "java", cpp: "cpp", c: "cpp", "c++": "cpp", cs: "cs", csharp: "cs",
    php: "php", bash: "bash", sh: "sh", shell: "bash", sql: "sql",
    css: "css", json: "json", yaml: "yaml", yml: "yaml",
    md: "md", markdown: "md", html: "html", xml: "html", text: "text", "": "text" };
  const key = norm[lang] || norm[lang.toLowerCase()] || "text";
  const rules = LANG_RULES[key] || LANG_RULES.text;
  const out = [];
  let i = 0;
  let lit = null;
  const tryRule = (rule) => {
    if (rule.startsWith && rule.startsWith.length && code.slice(i, i + rule.startsWith.length) !== rule.startsWith) return false;
    return rule.re.test(code.slice(i));
  };
  let safety = code.length * 8;
  while (i < code.length && safety-- > 0) {
    let matched = null;
    if (lit && lit.kind === "block") {
      const end = lit.endRe || lit.re;
      end.lastIndex = i;
      const m = end.exec(code);
      if (m && m.index === i) {
        out.push({ c: lit.cls, t: lit.re.source + "..." }); i += (m[0] || "").length || 1; lit = null; continue;
      }
    }
    if (lit && lit.kind === "line") {
      const nl = code.indexOf("\n", i);
      const end = nl === -1 ? code.length : nl;
      out.push({ c: lit.cls, t: code.slice(i, end) }); i = end; lit = null; continue;
    }
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(code);
      if (m && m.index === i) {
        matched = { cls: r.cls, len: m[0].length };
        if (r._start) lit = { kind: "line", re: r.re, cls: r.cls };
        if (r._block_open) lit = { kind: "block", re: r._block_open.re, endRe: r._block_open.end, cls: r.cls };
        break;
      }
    }
    if (matched) { out.push({ c: matched.cls, t: code.slice(i, i + matched.len) }); i += matched.len; }
    else { out.push({ c: "t", t: code[i] }); i++; }
  }
  return out.map((s, k) => React.createElement("span", { key: "t" + k, className: "tk-" + s.c }, s.t));
}

const LANG_RULES = {
  text: [ { re: /[A-Za-z_][\w]*/y, cls: "idt" } ],
  js: [
    { re: /\/\/[^\n]*/y, cls: "cm" },
    { re: /\/\*[\s\S]*?\*\//y, cls: "cm" },
    { re: /`(?:\\.[^`\\])*`/y, cls: "st" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])*'/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?(?:[eE]-?\d+)?\b/y, cls: "nm" },
    { re: /\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|super|this|import|export|from|as|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|yield|do|default|null|undefined|true|false)\b/y, cls: "kw" },
    { re: /\b[A-Za-z_][\w]*/y, cls: "idt" },
  ],
  ts: [
    { re: /\/\/[^\n]*/y, cls: "cm" },
    { re: /\/\*[\s\S]*?\*\//y, cls: "cm" },
    { re: /`(?:\\.[^`\\])*`/y, cls: "st" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])*'/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: "nm" },
    { re: /@[A-Za-z_][\w]*/y, cls: "de" },
    { re: /\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|super|this|import|export|from|as|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|yield|do|default|null|undefined|true|false|interface|type|enum|public|private|protected|readonly|abstract|implements|namespace|declare|keyof|never|unknown|any|void)\b/y, cls: "kw" },
    { re: /\b[A-Za-z_][\w]*/y, cls: "idt" },
  ],
  py: [
    { re: /#[^\n]*/y, cls: "cm" },
    { re: /"""[^"]*?"""/y, cls: "st" },
    { re: /'''[^']*?'''/y, cls: "st" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])*'/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?(?:[eE]-?\d+)?j?\b/y, cls: "nm" },
    { re: /\b(?:def|class|return|if|elif|else|for|while|break|continue|pass|import|from|as|try|except|finally|raise|with|yield|async|await|lambda|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|def)\b/y, cls: "kw" },
    { re: /\b[A-Za-z_][\w]*/y, cls: "idt" },
  ],
  rb: [
    { re: /#[^\n]*/y, cls: "cm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])*'/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: "nm" },
    { re: /\b(?:def|class|module|return|if|elsif|else|unless|case|when|while|until|for|in|do|break|next|redo|begin|rescue|ensure|raise|alias|undef|yield|self|nil|true|false|and|or|not|attr_accessor|attr_reader|attr_writer)\b/y, cls: "kw" },
    { re: /@\w+/y, cls: "de" },
    { re: /:[A-Za-z_][\w]*/y, cls: "nm" },
    { re: /\b[A-Za-z_][\w]*/y, cls: "idt" },
  ],
  go: [
    { re: /\/\/[^\n]*/y, cls: "cm" },
    { re: /\/\*[\s\S]*?\*\//y, cls: "cm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /`[^`]*`/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: "nm" },
    { re: /\b(?:func|var|const|type|struct|interface|package|import|return|if|else|for|range|switch|case|default|break|continue|fallthrough|go|defer|select|chan|map|nil|true|false)\b/y, cls: "kw" },
    { re: /\b[A-Za-z_][\w]*/y, cls: "idt" },
  ],
  rs: [
    { re: /\/\/[^\n]*/y, cls: "cm" },
    { re: /\/\*[\s\S]*?\*\//y, cls: "cm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: "nm" },
    { re: /\b(?:fn|let|mut|const|static|pub|use|crate|mod|impl|trait|struct|enum|match|if|else|for|while|loop|return|break|continue|self|super|in|where|as|ref|move|true|false|None|Some|Ok|Err)\b/y, cls: "kw" },
    { re: /\b[A-Za-z_][\w]*/y, cls: "idt" },
  ],
  java: [
    { re: /\/\/[^\n]*/y, cls: "cm" },
    { re: /\/\*[\s\S]*?\*\//y, cls: "cm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])'/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?[fFdDlL]?\b/y, cls: "nm" },
    { re: /\b(?:public|private|protected|class|interface|extends|implements|static|final|abstract|void|int|long|double|float|boolean|byte|short|char|if|else|for|while|do|switch|case|break|continue|return|new|this|super|try|catch|finally|throw|throws|import|package|null|true|false)\b/y, cls: "kw" },
    { re: /\b[A-Z][\w]*/y, cls: "typ" },
    { re: /\b[a-z_][\w]*/y, cls: "idt" },
  ],
  cpp: [
    { re: /\/\/[^\n]*/y, cls: "cm" },
    { re: /\/\*[\s\S]*?\*\//y, cls: "cm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])'/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: "nm" },
    { re: /\b(?:int|long|short|char|bool|float|double|void|auto|const|constexpr|static|extern|inline|virtual|override|class|struct|public|private|protected|using|namespace|template|typename|new|delete|this|nullptr|true|false|if|else|for|while|do|switch|case|break|continue|return|try|catch|throw|operator)\b/y, cls: "kw" },
    { re: /\b[A-Z][\w]*/y, cls: "typ" },
    { re: /\b[a-z_][\w]*/y, cls: "idt" },
  ],
  cs: [
    { re: /\/\/[^\n]*/y, cls: "cm" },
    { re: /\/\*[\s\S]*?\*\//y, cls: "cm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /@"(?:\\.[^"])*"/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?[fFmM]?\b/y, cls: "nm" },
    { re: /\b(?:public|private|protected|internal|class|struct|interface|enum|record|static|sealed|abstract|virtual|override|new|partial|void|int|long|short|byte|bool|float|double|decimal|string|char|object|var|if|else|for|foreach|while|do|switch|case|break|continue|return|try|catch|finally|throw|using|namespace|null|true|false|async|await|yield|this|base)\b/y, cls: "kw" },
    { re: /\b[A-Z][\w]*/y, cls: "typ" },
    { re: /\b[a-z_][\w]*/y, cls: "idt" },
  ],
  php: [
    { re: /\/\/[^\n]*/y, cls: "cm" },
    { re: /#![^\n]*/y, cls: "cm" },
    { re: /\/\*[\s\S]*?\*\//y, cls: "cm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])*'/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: "nm" },
    { re: /\$\w+/y, cls: "nm" },
    { re: /\b(?:function|return|if|else|elseif|for|foreach|while|do|switch|case|break|continue|class|interface|extends|implements|public|private|protected|static|const|var|new|this|self|parent|namespace|use|as|try|catch|finally|throw|true|false|null)\b/y, cls: "kw" },
    { re: /\b[A-Za-z_][\w]*/y, cls: "idt" },
  ],
  bash: [
    { re: /#[^\n]*/y, cls: "cm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])*'/y, cls: "st" },
    { re: /\b\d+\b/y, cls: "nm" },
    { re: /\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|exit|export|local|set|unset|declare|alias|source|echo|cd|pwd|ls|cat|grep|sed|awk|true|false)\b/y, cls: "kw" },
    { re: /^\s*\$\w+/y, cls: "nm" },
    { re: /--?[A-Za-z][\w-]*/y, cls: "nm" },
    { re: /\b[A-Za-z_][\w]*/y, cls: "idt" },
  ],
  sh: [
    { re: /#[^\n]*/y, cls: "cm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])*'/y, cls: "st" },
    { re: /\b\d+\b/y, cls: "nm" },
    { re: /\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|exit|export|local|set|echo|cd|pwd|ls|cat|grep|sed|awk|true|false)\b/y, cls: "kw" },
    { re: /^\s*\$\w+/y, cls: "nm" },
    { re: /--?[A-Za-z][\w-]*/y, cls: "nm" },
    { re: /\b[A-Za-z_][\w]*/y, cls: "idt" },
  ],
  sql: [
    { re: /--[^\n]*/y, cls: "cm" },
    { re: /\/\*[\s\S]*?\*\//y, cls: "cm" },
    { re: /'(?:\\.[^'\\])*'/y, cls: "st" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: "nm" },
    { re: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|VIEW|DROP|ALTER|ADD|COLUMN|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|GROUP|BY|ORDER|LIMIT|OFFSET|UNION|ALL|DISTINCT|HAVING|EXISTS|IN|BETWEEN|LIKE|IS|NULL|NOT|AND|OR|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|DEFAULT|CHECK|CASCADE|RESTRICT)\b/yi, cls: "kw" },
    { re: /\b[A-Za-z_][\w]*/y, cls: "idt" },
  ],
  css: [
    { re: /\/\*[\s\S]*?\*\//y, cls: "cm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])*'/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|pt|px|ms|s|fr|deg|rad)?\b/y, cls: "nm" },
    { re: /#[0-9a-fA-F]{3,8}\b/y, cls: "nm" },
    { re: /\b(?:important|inherit|none|block|flex|grid|inline|none|absolute|relative|fixed|static|sticky|auto|hidden|visible)\b/y, cls: "kw" },
    { re: /[a-z-]+(?=\s*:)/y, cls: "idt" },
    { re: /[\w-]+/y, cls: "idt" },
  ],
  json: [
    { re: /"(?:\\.[^"\\])*"(?=\s*:)/y, cls: "nm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?(?:[eE]-?\d+)?\b/y, cls: "nm" },
    { re: /\b(?:true|false|null)\b/y, cls: "kw" },
  ],
  yaml: [
    { re: /#[^\n]*/y, cls: "cm" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])*'/y, cls: "st" },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: "nm" },
    { re: /\b(?:true|false|null|yes|no|on|off)\b/yi, cls: "kw" },
    { re: /^[ \t-]*[\w-]+(?=:)/y, cls: "nm" },
    { re: /[\w-]+/y, cls: "idt" },
  ],
  md: [
    { re: /^#{1,6}\s.+/y, cls: "kw" },
    { re: /\*\*[^*\n]+\*\*/y, cls: "kw" },
    { re: /`[^`\n]+`/y, cls: "st" },
    { re: /\[[^\]\n]+\]\([^)\n]+\)/y, cls: "nm" },
    { re: /(?:^|\s)https?:\/\/\S+/y, cls: "nm" },
  ],
  html: [
    { re: /<!--[\s\S]*?-->/y, cls: "cm" },
    { re: /<\/?[a-zA-Z][\w-]*/y, cls: "kw" },
    { re: /\s[a-zA-Z][\w-]*(?==)/y, cls: "typ" },
    { re: /"(?:\\.[^"\\])*"/y, cls: "st" },
    { re: /'(?:\\.[^'\\])*'/y, cls: "st" },
    { re: /\/?>/y, cls: "kw" },
  ],
};

function renderMarkdown(md) {
  const lines = String(md || "").split("\n");
  const blocks = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { codeLines.push(lines[i]); i++; }
      i++;
      const code = codeLines.join("\n");
      if (lang === "html") {
        blocks.push(React.createElement("iframe", {
          key: key++,
          srcDoc: code,
          sandbox: "allow-scripts",
          title: "Embedded HTML",
          className: "w-full h-48 rounded-md border border-[var(--ui-stroke-secondary)] bg-[var(--background)]",
        }));
      } else {
        const tokens = highlightCode(code, lang);
        blocks.push(React.createElement("pre", {
          key: key++,
          className: "p-2.5 rounded-md bg-[var(--muted)] overflow-auto text-[0.75rem] my-1.5 font-mono leading-snug",
        }, tokens));
      }
      continue;
    }
    if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(React.createElement("li", { key: key++ }, renderInline(lines[i].replace(/^[-*] /, ""), "li" + key)));
        i++;
      }
      blocks.push(React.createElement("ul", { key: key++, className: "list-disc pl-4 my-1 space-y-0.5" }, items));
      continue;
    }
    if (/^#{1,4} /.test(line)) {
      const lvl = line.match(/^(#+)/)[1].length;
      const text = line.replace(/^#+ /, "");
      const Tag = ["h1", "h2", "h3", "h4"][Math.min(lvl, 4) - 1];
      blocks.push(React.createElement(Tag, { key: key++, className: "font-medium mt-2 mb-1 text-[var(--ui-text-primary)]" }, renderInline(text, "h" + key)));
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^[-*] /.test(lines[i]) && !/^#{1,4} /.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(React.createElement("p", { key: key++, className: "my-1 text-[var(--ui-text-primary)]" }, renderInline(para.join(" "), "p" + key)));
  }
  return blocks.length ? blocks : React.createElement("span", null, String(md || ""));
}

function friendlyError(e) {
  const msg = (e && e.message) || String(e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return "The definition backend is not reachable. Restart Hermes Desktop so the backend plugin loads, then try again.";
  }
  if (/CORS|Cross-Origin/i.test(msg) || /Access-Control-Allow-Origin/i.test(msg)) {
    return "The provider blocks browser requests (CORS). Use the Gateway transport or a CORS-permitting endpoint.";
  }
  if (/gateway unavailable|not connected|connection closed/i.test(msg)) {
    return "The Hermes gateway is not connected. Check your gateway connection, then try again.";
  }
  return msg;
}

const SESSION_MODEL = "__session__";

let gatewayModelsCache = null;
let backendBaseUrl = "http://127.0.0.1:8643";
let backendBaseProbed = false;

async function ensureBackendBase() {
  if (backendBaseProbed) return backendBaseUrl;
  backendBaseProbed = true;
  try {
    if (host && typeof host.request === "function") {
      const r = await host.request("cli.exec", { argv: ["insight", "--sse-url"], timeout: 30 });
      const stdout = (r && r.result && (r.result.output || r.result.stdout)) || (r && r.output) || "";
      const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) {
        const parsed = JSON.parse(line);
        if (parsed.sse_url) backendBaseUrl = parsed.sse_url.replace(/\/+$/, "");
      }
    }
  } catch { }
  return backendBaseUrl;
}

async function fetchGatewayModels() {
  if (gatewayModelsCache) return gatewayModelsCache;
  let providers = [];
  let viaGateway = false;
  try {
    if (host && typeof host.request === "function") {
      const r = await host.request("model.options", { explicit_only: false, include_unconfigured: true });
      const payload = (r && r.result) || r || {};
      const list = payload.providers || payload.data || [];
      if (Array.isArray(list) && list.length) {
        providers = list;
        viaGateway = true;
      }
    }
  } catch { }
  if (!providers.length) {
    const base = await ensureBackendBase();
    try {
      const r2 = await fetch(base + "/providers");
      if (r2.ok) {
        const parsed = await r2.json();
        providers = parsed.providers || [];
      }
    } catch { }
  }
  const mapped = providers
    .map((p) => ({
      id: p.id || p.slug || p.name,
      name: p.name || p.id || p.slug || "Provider",
      base_url: p.base_url || p.api_url || p.url || "",
      models: (p.models || [])
        .map((m) => (typeof m === "string" ? m : m.id || m.model || m.name))
        .filter(Boolean),
    }))
    .filter((p) => p.id);
  gatewayModelsCache = { providers: mapped, viaGateway };
  return gatewayModelsCache;
}

function SelectionPopupHost() {
  const [popup, setPopup] = useState(null);
  const panelOpen = useValue(panelOpenAtom);

  useEffect(() => {
    const onMouseUp = () => {
      const frag = currentSelectionFragment();
      if (!frag) { setPopup(null); return; }
      const md = serializeFragment(frag);
      if (!md.trim()) { setPopup(null); return; }
      const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
      setPopup({ x: r.left + r.width / 2, y: r.top, md });
    };
    const onSelChange = () => {
      if (window.getSelection().isCollapsed) setPopup(null);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        setPopup(null);
        if (panelOpenAtom.get()) panelOpenAtom.set(false);
      }
    };
    const onMouseDown = (e) => {
      if (!e.target || !e.target.closest || !e.target.closest("[data-insight]")) {
        setPopup(null);
      }
    };

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);

    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelChange);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, []);

  const quoted = popup ? buildQuote(popup.md) : "";
  const popupStyle = popup
    ? {
        position: "fixed",
        left: popup.x + "px",
        top: Math.max(8, popup.y - 8) + "px",
        transform: "translate(-50%, -100%)",
        zIndex: 130,
        display: "flex",
        alignItems: "center",
        gap: "4px",
        padding: "4px",
        background: "var(--popover-surface, var(--popover, var(--background, #fff)))",
        color: "var(--popover-foreground, var(--foreground, #1c1c1e))",
        border: "1px solid var(--ui-stroke-secondary, var(--border, rgba(128,128,128,.28)))",
        borderRadius: "var(--radius-lg, var(--radius, 0.625rem))",
        boxShadow: "0 8px 24px -12px color-mix(in srgb, #000 24%, transparent)",
        fontFamily: "var(--font-sans, inherit)",
        fontSize: "var(--conversation-text-font-size, 0.8125rem)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }
    : {};
  const btnBase = {
    border: 0,
    cursor: "pointer",
    padding: "3px 10px",
    borderRadius: "6px",
    font: "inherit",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
  };

  return React.createElement(
    React.Fragment,
    null,
    popup &&
      React.createElement(
        "div",
        {
          "data-insight": "1",
          style: popupStyle,
          onMouseDown: (e) => e.stopPropagation(),
        },
        React.createElement(
          "button",
          {
            style: { ...btnBase, background: "var(--primary, #0053fd)", color: "var(--primary-foreground, #fff)" },
            onClick: () => { insertQuoteIntoComposer(quoted); setPopup(null); },
            title: "Insert as quoted response",
          },
          "Respond"
        ),
        React.createElement(
          "button",
          {
            style: {
              ...btnBase,
              background: "var(--popover-surface, transparent)",
              color: "var(--popover-foreground, inherit)",
              border: "1px solid var(--ui-stroke-secondary, var(--border))",
            },
            onClick: () => { setPopup(null); defineSelection(); },
            title: "Define in the side panel",
          },
          React.createElement(Codicon, { name: "book", size: 14 }),
          "Define"
        )
      ),
    panelOpen &&
      React.createElement(DefsPane, { onClose: () => panelOpenAtom.set(false) })
  );
}

function DefsPane({ onClose }) {
  React.useEffect(() => {
    if (document.getElementById("insight-styles")) return;
    const s = document.createElement("style");
    s.id = "insight-styles";
    s.textContent =
      `.tk-kw{color:var(--ui-accent);font-weight:600}` +
      `.tk-st{color:#16a34a}` +
      `.tk-cm{color:var(--ui-text-tertiary);font-style:italic}` +
      `.tk-nm{color:#2563eb}` +
      `.tk-idt{color:var(--ui-text-secondary)}` +
      `.tk-typ{color:#9333ea}` +
      `.tk-de{color:#d97706}` +
      `.tk-t{color:inherit}` +
      `a.insight-link{color:var(--ui-accent);text-decoration:underline;` +
      `text-decoration-thickness:1px;text-underline-offset:2px;cursor:pointer}` +
      `a.insight-link:hover{text-decoration-thickness:2px}` +
      `.insight-hidden{display:none !important}` +
      `a.insight-link{text-decoration:underline !important}` +
      `@keyframes insight-caret-blink{0%,49%{opacity:1}50%,100%{opacity:0}}` +
      `.insight-caret{display:inline-block;width:0.5ch;height:1em;` +
      `background:var(--ui-accent);margin-left:1px;vertical-align:text-bottom;` +
      `animation:insight-caret-blink 0.9s steps(2,end) infinite}`;
    document.head.appendChild(s);
  }, []);

  const settings = useValue(settingsAtom);
  const term = useValue(termAtom);
  const requestId = useValue(requestIdAtom);
  const [draftTerm, setDraftTerm] = useState(term);
  const [out, setOut] = useState(() => ({
    status: "idle",
    text: "",
    error: "",
    sources: [],
  }));
  const [showTemplate, setShowTemplate] = useState(false);
  const [showProviders, setShowProviders] = useState(false);
  const [templateDraft, setTemplateDraft] = useState(settings.template);
  const [newProvider, setNewProvider] = useState(null);
  const [importText, setImportText] = useState("");
  const [gwModels, setGwModels] = useState(null);
  const [gwModelsError, setGwModelsError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef(null);
  const startRef = useRef(0);
  const timerRef = useRef(null);

  const stopTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };
  const startTimer = () => {
    startRef.current = Date.now();
    setElapsed(0);
    stopTimer();
    timerRef.current = setInterval(() => setElapsed((Date.now() - startRef.current) / 1000), 100);
  };

  useEffect(() => { setDraftTerm(term); }, [term]);

  useEffect(() => {
    let alive = true;
    fetchGatewayModels()
      .then((m) => { if (alive) { setGwModels(m); setGwModelsError(""); } })
      .catch((e) => { if (alive) { setGwModels(null); setGwModelsError((e && e.message) || "Gateway models unavailable."); } });
    return () => { alive = false; };
  }, []);

  const gatewayProviderList = (gwModels && gwModels.providers) || [];
  const providerList = gatewayProviderList.length ? gatewayProviderList : settings.providers;
  const selProvider = findProvider(providerList, settings.last.providerId) || null;
  const modelValue = settings.last.model || SESSION_MODEL;
  const modelOptions = [SESSION_MODEL, ...((selProvider && selProvider.models) || [])];

  const run = useCallback((termText) => {
    if (!termText) return;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    startTimer();
    setOut({ status: "streaming", text: "", error: "", sources: [] });

    (async () => {
      try {
        const params = new URLSearchParams({
          term: termText,
          template: settings.template || "",
          search: settings.search.enabled ? "1" : "0",
        });
        if (settings.last.providerId && settings.last.providerId !== SESSION_MODEL) {
          params.set("provider", settings.last.providerId);
        }
        if (settings.last.model && settings.last.model !== SESSION_MODEL) {
          params.set("model", settings.last.model);
        }
        let sid = "";
        try {
          const s = host.state && host.state.activeSessionId;
          sid = s && typeof s.get === "function" ? s.get() : s || "";
        } catch { }
        if (sid) params.set("session_id", sid);

        let res;
        try {
          const base = await ensureBackendBase();
          res = await fetch(base + "/complete?" + params.toString(), { signal: ctrl.signal });
        } catch (netErr) {
          const argv = ["insight", "--term", termText, "--template", settings.template || "",
                        "--search", settings.search.enabled ? "1" : "0"];
          if (settings.last.providerId && settings.last.providerId !== SESSION_MODEL) argv.push("--provider", settings.last.providerId);
          if (settings.last.model && settings.last.model !== SESSION_MODEL) argv.push("--model", settings.last.model);
          const r = await host.request("cli.exec", { argv, timeout: 240 });
          const out = (r && r.result) || r || {};
          const stdout = out.output || out.stdout || "";
          const jsonLine = stdout.split("\n").find((l) => l.trim().startsWith("{"));
          if (!jsonLine) throw new Error("Backend unavailable: " + String(stdout).slice(0, 160));
          const parsed = JSON.parse(jsonLine);
          if (parsed.error) throw new Error(parsed.error);
          const evs = (parsed.events || []).filter((e) => e.event === "delta").map((e) => e.data).join("");
          const doneEv = (parsed.events || []).find((e) => e.event === "done");
          const finalText = (doneEv && doneEv.data && doneEv.data.text) || evs;
          setOut({ status: "done", text: finalText || "", error: "", sources: (doneEv && doneEv.data && doneEv.data.sources) || [] });
          return;
        }
        if (!res.ok || !res.body) {
          throw new Error("Backend returned HTTP " + res.status);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let acc = "";
        let sources = [];
        let finished = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = (frame.match(/^event: (.+)$/m) || [])[1] || "";
            const data = (frame.match(/^data: (.+)$/m) || [])[1] || "";
            if (!data) continue;
            let j;
            try { j = JSON.parse(data); } catch { continue; }
            if (ev === "delta" && typeof j === "string") {
              acc += j;
              setOut({ status: "streaming", text: acc, error: "", sources });
            } else if (ev === "sources") {
              sources = j;
              setOut({ status: "streaming", text: acc, error: "", sources });
            } else if (ev === "done") {
              acc = j.text || acc;
              sources = j.sources || sources;
              finished = true;
              setOut({ status: "done", text: acc, error: "", sources });
            } else if (ev === "error") {
              throw new Error(typeof j === "string" ? j : String(j));
            }
          }
        }
        if (acc && !finished) setOut({ status: "done", text: acc, error: "", sources });
      } catch (e) {
        if (e && e.name === "AbortError") return;
        setOut({ status: "error", text: "", error: friendlyError(e), sources: [] });
      } finally {
        if (abortRef.current === ctrl) {
          stopTimer();
          setElapsed((Date.now() - startRef.current) / 1000);
        }
      }
    })();
  }, [settings.template, settings.search.enabled, settings.last.providerId, settings.last.model]);

  useEffect(() => {
    if (requestId > 0 && term) run(term);
  }, [requestId]);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); stopTimer(); }, []);

  const onDefine = () => {
    const t = capTerm(draftTerm);
    termAtom.set(t);
    requestIdAtom.set(requestIdAtom.get() + 1);
    run(t);
  };

  const clearKeys = () => {
    patchSettings({
      providers: settings.providers.map((p) => ({ ...p, api_key: "" })),
    });
  };

  const applyImport = () => {
    try {
      const arr = JSON.parse(importText);
      if (!Array.isArray(arr)) throw new Error("expected array");
      patchSettings({ providers: arr });
      setImportText("");
      setShowProviders(true);
    } catch (e) {
      host.notify({ kind: "error", message: "Import failed: " + e.message });
    }
  };

  const rootStyle = {
    position: "fixed",
    right: 12,
    top: 56,
    bottom: 36,
    width: 340,
    zIndex: 120,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    background: "var(--popover-surface, var(--popover, var(--background, #fff)))",
    color: "var(--popover-foreground, var(--foreground, #1c1c1e))",
    border: "1px solid var(--ui-stroke-secondary, var(--border, rgba(128,128,128,.28)))",
    borderRadius: "var(--radius-lg, var(--radius, 0.625rem))",
    boxShadow: "0 8px 24px -12px color-mix(in srgb, #000 24%, transparent)",
    fontFamily: "var(--font-sans, inherit)",
    fontSize: "var(--conversation-text-font-size, 0.8125rem)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
  };
  const labelStyle = { fontSize: "0.6875rem", color: "var(--ui-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" };
  const rowStyle = { display: "flex", alignItems: "center", gap: "6px" };

  const searchInfo = (() => {
    if (!settings.search.enabled) return null;
    if (settings.search.preset === "standard") {
      const ep = settings.search.endpoint || "";
      if (!ep.trim()) return "Standard · auto (web.search_backend)";
      try {
        const u = new URL(ep);
        return "Standard · " + u.host + (u.pathname && u.pathname !== "/" ? u.pathname : "");
      } catch (z) { return "Standard · (invalid endpoint)"; }
    }
    if (settings.search.preset === "custom") {
      const ep = settings.search.endpoint || "";
      if (!ep.trim()) return "Custom · (no endpoint)";
      try {
        const u = new URL(ep);
        return "Custom · " + u.host + (u.pathname && u.pathname !== "/" ? u.pathname : "");
      } catch (z) { return "Custom · (invalid endpoint)"; }
    }
    return settings.search.preset || "on";
  })();
  const webChip = (() => {
    if (!settings.search.enabled) {
      return null;
    }
    if (out.sources.length > 0) {
      return React.createElement("div", {
        "data-web-chip": "1",
        className: "flex items-center gap-1.5 mt-1",
        title: "Searched via " + searchInfo,
      },
        React.createElement(Badge, { variant: "outline", className: "gap-1 text-[0.6875rem] font-normal" },
          React.createElement(Codicon, { name: "globe", size: 12 }),
          "Web · " + searchInfo + " · " + out.sources.length + " " + (out.sources.length === 1 ? "source" : "sources")
        )
      );
    }
    return React.createElement("div", {
      "data-web-chip": "empty",
      className: "flex items-center gap-1.5 mt-1",
      title: "Search via " + searchInfo + " returned no results",
    },
      React.createElement(Badge, { variant: "outline", className: "gap-1 text-[0.6875rem] font-normal" },
        React.createElement(Codicon, { name: "search", size: 12 }),
        "Web · " + searchInfo + " · 0 results"
      )
    );
  })();

  return React.createElement(
    "div",
    { style: rootStyle, className: "p-3" },
    React.createElement(
      "div",
      { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } },
      React.createElement("span", { className: "text-xs font-medium" }, "Definition"),
      React.createElement(Button, {
        size: "sm",
        variant: "ghost",
        onClick: onClose,
        "aria-label": "Close definition panel",
        title: "Close panel (plugin stays enabled)",
      },
        React.createElement(Codicon, { name: "close", size: 14 }))
    ),
    React.createElement(
      "div",
      { style: rowStyle, className: "w-full" },
      React.createElement(Input, {
        className: "flex-1 min-w-0",
        value: draftTerm,
        placeholder: "Term to define…",
        onChange: (e) => setDraftTerm(e.target.value),
        onKeyDown: (e) => { if (e.key === "Enter") onDefine(); },
      }),
      React.createElement(Button, { size: "sm", onClick: onDefine }, "Define")
    ),
    React.createElement(
      "div",
      { style: { ...rowStyle, marginTop: 8, flexWrap: "wrap" } },
      React.createElement(Select, {
        value: settings.last.providerId || (selProvider && selProvider.id) || "",
        onValueChange: (v) => patchSettings({ last: { ...settings.last, providerId: v, model: "" } }),
      },
        React.createElement(SelectTrigger, { className: "w-[150px] h-7 text-xs" },
          React.createElement(SelectValue, { placeholder: "Provider (gateway list)" })),
        React.createElement(SelectContent, null,
          providerList.length === 0 &&
            React.createElement(SelectItem, { value: "__none__", disabled: true },
              gwModelsError || "Loading gateway provider list…"),
          providerList.map((p) =>
            React.createElement(SelectItem, { key: p.id, value: p.id }, p.name)
          )
        )
      ),
      React.createElement(Select, {
        value: modelValue || "",
        onValueChange: (v) => patchSettings({ last: { ...settings.last, model: v } }),
      },
        React.createElement(SelectTrigger, { className: "w-[150px] h-7 text-xs" },
          React.createElement(SelectValue, { placeholder: "Model" })),
        React.createElement(SelectContent, null,
          (modelOptions.length ? modelOptions : [modelValue || "default"]).map((m) =>
            React.createElement(SelectItem, { key: m, value: m },
              m === SESSION_MODEL ? "Session model (current chat)" : m
            )
          )
        )
      ),
      React.createElement(
        "div", { style: rowStyle, title: "Web search before defining" },
        React.createElement(Switch, {
          checked: !!settings.search.enabled,
          onCheckedChange: (v) => patchSettings({ search: { ...settings.search, enabled: !!v } }),
        }),
        React.createElement(Codicon, { name: "globe", size: 13 })
      )
    ),
    React.createElement(
      "div",
      { style: { ...rowStyle, marginTop: 6, gap: 8 } },
      React.createElement(
        "label", { style: labelStyle },
        "Provider list"
      ),
      React.createElement(
        "span", { style: { color: "var(--ui-text-tertiary)", fontSize: "0.6875rem", flex: 1 } },
        "Gateway model.options → direct connection (no agent, no memory)"
      )
    ),
    React.createElement(Separator, { className: "my-2" }),
    React.createElement(
      "div",
      { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
      React.createElement(
        "div",
        { style: { flex: 1, minHeight: 0, overflow: "auto" } },
      out.status === "idle" &&
        React.createElement(EmptyState, {
          title: "Select text and hit Define",
          description: "The definition streams here. Edit the format template below.",
        }),
      out.status === "streaming" &&
        React.createElement(
          "div",
          { className: "space-y-1" },
          React.createElement("div", { className: "text-xs text-[var(--ui-text-tertiary)] flex items-center gap-2" },
            React.createElement(Loader, { className: "size-3", label: "Defining…" }),
            React.createElement("span", { style: { opacity: 0.7 } },
              (modelOptions[0] === SESSION_MODEL && !settings.last.model ? "session model" : (settings.last.model || "session model")) +
              " · " + elapsed.toFixed(1) + "s"
            )
          ),
          React.createElement(
            "div",
            { className: "whitespace-pre-wrap break-words" },
            renderMarkdown(out.text),
            React.createElement("span", { className: "insight-caret", key: "caret" })
          ),
          webChip
        ),
      out.status === "done" &&
        React.createElement(
          "div",
          { className: "space-y-2" },
          out.text && !/!\[[^\]]*\]\([^)]+\)/.test(out.text) &&
            (() => {
              const withImg = out.sources.find((x) => x.image);
              return withImg
                ? React.createElement(
                    "div",
                    { style: { marginBottom: "0.25rem" } },
                    inlineImage(withImg),
                    React.createElement(
                      "div",
                      {
                        style: {
                          fontSize: "0.6875rem",
                          color: "var(--ui-text-tertiary)",
                          marginTop: "0.125rem",
                        },
                      },
                      "Image: ",
                      withImg.url
                        ? React.createElement(
                          "a",
                          {
                            href: withImg.url,
                            target: "_blank",
                            rel: "noreferrer",
                            className: "insight-link",
                            style: { textDecoration: "underline", textDecorationThickness: "1px", textUnderlineOffset: "2px" },
                          },
                          withImg.title || withImg.url
                        )
                        : withImg.title
                    )
                  )
                : null;
            })(),
          React.createElement("div", { className: "whitespace-pre-wrap break-words" }, renderMarkdown(out.text)),
          webChip,
          out.sources.length > 0 &&
            React.createElement(
              "div",
              { className: "pt-2" },
              React.createElement("div", { style: labelStyle }, "Sources"),
              React.createElement(
                "ol",
                {
                  style: {
                    listStyle: "none",
                    paddingLeft: 0,
                    margin: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.25rem",
                  },
                },
                out.sources.map((s, i) => [
                  React.createElement(
                    "li",
                    {
                      key: i,
                      className: "text-xs break-words",
                      style: { display: "flex", gap: "0.375rem", alignItems: "baseline", flexWrap: "wrap" },
                    },
                    React.createElement(
                      "span",
                      {
                        style: {
                          color: "var(--ui-text-tertiary)",
                          fontVariantNumeric: "tabular-nums",
                          minWidth: "1.25rem",
                          flexShrink: 0,
                        },
                      },
                      String(i + 1) + "."
                    ),
                    s.url
                      ? React.createElement(
                          "a",
                          {
                            href: s.url,
                            target: "_blank",
                            rel: "noreferrer",
                            className: "insight-link",
                            style: { textDecoration: "underline", textDecorationThickness: "1px", textUnderlineOffset: "2px", wordBreak: "break-all" },
                          },
                          s.title || s.url
                        )
                      : s.title
                  )
                ])
              )
            )
        ),
      out.status === "error" &&
        React.createElement(ErrorState,
          { title: "Definition failed", description: out.error },
          React.createElement(Button, { size: "sm", onClick: () => run(draftTerm || term) }, "Try again")
        )
      ),
      React.createElement(
        "div",
        { style: { display: "flex", justifyContent: "flex-end", alignItems: "center", minHeight: 16, paddingTop: 2 } },
        (out.status === "streaming" || out.status === "done" || out.status === "error") &&
          React.createElement("span", {
            "data-timer": "1",
            style: { fontSize: "0.6875rem", color: "var(--ui-text-tertiary)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
          }, elapsed.toFixed(1) + "s")
      )
    ),
    React.createElement(Separator, { className: "my-2" }),
    React.createElement(
      "div",
      { className: "space-y-1" },
      React.createElement(
        "button",
        {
          className: "flex items-center gap-1.5 text-xs font-medium w-full text-left",
          onClick: () => setShowTemplate(!showTemplate),
        },
        React.createElement(Codicon, { name: showTemplate ? "chevron-down" : "chevron-right", size: 12 }),
        "Format template"
      ),
      showTemplate &&
        React.createElement(
          "div",
          { className: "space-y-1" },
          React.createElement(Textarea, {
            className: "text-xs font-mono",
            style: { height: 150, resize: "vertical" },
            value: templateDraft,
            onChange: (e) => setTemplateDraft(e.target.value),
          }),
          React.createElement(
            "div", { style: rowStyle },
            React.createElement(Button, {
              size: "sm",
              onClick: () => { patchSettings({ template: templateDraft }); host.notify({ kind: "success", message: "Format template saved." }); },
            }, "Save"),
            React.createElement(Button, {
              size: "sm",
              variant: "ghost",
              onClick: () => { setTemplateDraft(settings.template); setShowTemplate(false); },
            }, "Cancel")
          )
        ),
      React.createElement(
        "button",
        {
          className: "flex items-center gap-1.5 text-xs font-medium w-full text-left",
          onClick: () => setShowProviders(!showProviders),
        },
        React.createElement(Codicon, { name: showProviders ? "chevron-down" : "chevron-right", size: 12 }),
        "Providers"
      ),
      showProviders &&
        React.createElement(
          "div",
          { className: "space-y-1.5" },
          settings.providers.map((p, idx) =>
            React.createElement(
              "div",
              { key: p.id, style: { ...rowStyle, justifyContent: "space-between" } },
              React.createElement(
                "div", { className: "min-w-0" },
                React.createElement("div", { className: "text-xs truncate" }, p.name),
                React.createElement("div", { className: "text-[0.6875rem] text-[var(--ui-text-tertiary)] truncate" }, p.base_url)
              ),
              React.createElement(Button, {
                size: "sm",
                variant: "ghost",
                onClick: () => patchSettings({ providers: settings.providers.filter((x) => x.id !== p.id) }),
                "aria-label": "Remove " + p.name,
              }, React.createElement(Codicon, { name: "trash", size: 12 }))
            )
          ),
          newProvider &&
            React.createElement(
              "div", { className: "space-y-1 p-1.5 border border-[var(--ui-stroke-secondary)] rounded" },
              React.createElement(Input, {
                className: "h-7 text-xs", placeholder: "Name",
                value: newProvider.name,
                onChange: (e) => setNewProvider({ ...newProvider, name: e.target.value }),
              }),
              React.createElement(Input, {
                className: "h-7 text-xs", placeholder: "Base URL (https://…/v1)",
                value: newProvider.base_url,
                onChange: (e) => setNewProvider({ ...newProvider, base_url: e.target.value }),
              }),
              React.createElement(Input, {
                className: "h-7 text-xs", type: "password", placeholder: "API key (optional)",
                value: newProvider.api_key,
                onChange: (e) => setNewProvider({ ...newProvider, api_key: e.target.value }),
              }),
              React.createElement(Input, {
                className: "h-7 text-xs", placeholder: "Models (comma-separated)",
                value: newProvider.models,
                onChange: (e) => setNewProvider({ ...newProvider, models: e.target.value }),
              }),
              React.createElement(
                "div", { style: rowStyle },
                React.createElement(Button, {
                  size: "sm",
                  onClick: () => {
                    const name = (newProvider.name || "").trim();
                    const base = (newProvider.base_url || "").trim();
                    if (!name || !base) { host.notify({ kind: "error", message: "Name and base URL are required." }); return; }
                    const models = (newProvider.models || "").split(",").map((s) => s.trim()).filter(Boolean);
                    patchSettings({
                      providers: [
                        ...settings.providers,
                        { id: "p" + Date.now().toString(36), name, base_url: base, api_key: (newProvider.api_key || "").trim(), models, default_model: models[0] || "" },
                      ],
                    });
                    setNewProvider(null);
                  },
                }, "Add"),
                React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => setNewProvider(null) }, "Cancel")
              )
            ),
          React.createElement(
            "div", { style: rowStyle },
            React.createElement(Button, { size: "sm", variant: "outline", onClick: () => setNewProvider({ name: "", base_url: "", api_key: "", models: "" }) },
              React.createElement(Codicon, { name: "add", size: 12 }), " Add"),
            React.createElement(Button, { size: "sm", variant: "ghost", onClick: clearKeys }, "Clear keys"),
            React.createElement(Button, {
              size: "sm", variant: "ghost",
              onClick: () => {
                setImportText(JSON.stringify(settings.providers, null, 2));
                setShowProviders(true);
              },
            }, "Export"),
            React.createElement(Button, { size: "sm", variant: "ghost", onClick: () => setImportText("") || setShowProviders(true) }, "Import")
          ),
          importText &&
            React.createElement(
              "div", { className: "space-y-1" },
              React.createElement(Textarea, {
                className: "h-24 text-xs font-mono",
                value: importText,
                onChange: (e) => setImportText(e.target.value),
                placeholder: '[{"name":"…","base_url":"…","api_key":"…","models":["…"]}]',
              }),
              React.createElement(Button, { size: "sm", onClick: applyImport }, "Apply import")
            )
        ),
      React.createElement(
        "button",
        {
          className: "flex items-center gap-1.5 text-xs font-medium w-full text-left",
          onClick: () => patchSettings({ search: { ...settings.search, enabled: !settings.search.enabled } }),
        },
        React.createElement(Codicon, { name: settings.search.enabled ? "globe" : "globe-off", size: 12 }),
        "Web search",
        React.createElement(Badge, { variant: settings.search.enabled ? "default" : "outline" }, settings.search.enabled ? "on" : "off")
      ),
      settings.search.enabled &&
        React.createElement(
          "div", { className: "space-y-1" },
          React.createElement(Select, {
            value: settings.search.preset,
            onValueChange: (v) => patchSettings({ search: { ...settings.search, preset: v } }),
          },
            React.createElement(SelectTrigger, { className: "h-7 text-xs w-full" },
              React.createElement(SelectValue, null)),
            React.createElement(SelectContent, null,
              React.createElement(SelectItem, { value: "standard" }, "Standard (web.search_backend)"),
              React.createElement(SelectItem, { value: "custom" }, "Custom JSON endpoint"),
              React.createElement(SelectItem, { value: "off" }, "Off")
            )
          ),
          settings.search.preset === "standard" &&
            React.createElement("div", { className: "text-[0.6875rem] text-[var(--ui-text-tertiary)]" },
              "Uses the install's web.search_backend (config). No setup needed."
            ),
          settings.search.preset === "custom" &&
            React.createElement(Input, {
              className: "h-7 text-xs", placeholder: "Endpoint URL (?q=<term>), JSON: {results:[{title,url,content}]}",
              value: settings.search.endpoint,
              onChange: (e) => patchSettings({ search: { ...settings.search, endpoint: e.target.value } }),
            })
        )
    )
  );
}

function findProvider(providers, id) {
  return (providers || []).find((p) => p.id === id) || null;
}

export default {
  id: "insight",
  name: "Insight",
  defaultEnabled: true,
  register(ctx) {
    _storage = ctx.storage;
    settingsAtom.set(loadSettings(ctx.storage));

    ctx.register({
      id: "selection-popup-host",
      area: STATUSBAR_AREAS.right,
      render: () => React.createElement(SelectionPopupHost),
    });

    ctx.register({
      id: "define-cmd",
      area: PALETTE_AREA,
      data: {
        id: "insight.define",
        label: "Define selection",
        keywords: ["define", "term", "selection", "definition"],
        run: () => { defineSelection(); },
      },
    });
  },
};