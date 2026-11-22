/**
 * The shared page: one self-contained HTML file (inline CSS and script, no network requests), interactive:
 * a searchable list of requests, Request / Response / curl tabs, copy buttons, JSON highlighting, light and dark.
 * The data is embedded as JSON and every value is put on the page with textContent, never as HTML.
 */
import type { ShareDoc } from './share'

/** JSON that is safe inside <script>: no "</script>", no line separators that end a JS string. */
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029)
const BS = String.fromCharCode(92) // a backslash: the page must get the escape sequences themselves
const embed = (doc: ShareDoc) => JSON.stringify(doc).split('<').join(BS + 'u003c').split(LS).join(BS + 'u2028').split(PS).join(BS + 'u2029')
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const CSS = `
:root{--bg:#F4F4F5;--panel:#fff;--solid:#fff;--sunken:rgba(23,23,23,.04);--line:rgba(23,23,23,.1);--ink:#171717;--muted:#525252;
--primary:#A86500;--fill:#FFB020;--on-fill:#1C1C1E;--soft:rgba(255,176,32,.16);--link:#8A5300;--good:#15803D;--warn:#965400;--bad:#C4262B;--info:#1D5FA8;
--get:#15803D;--post:#965400;--put:#1D5FA8;--patch:#6B3FA0;--delete:#C4262B;--k:#6b3fa0;--s:#15803d;--n:#965400;--l:#1d5fa8;
--shadow:0 8px 24px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05);color-scheme:light}
:root[data-theme=dark]{--bg:#0F0F10;--panel:#161617;--solid:#1C1C1E;--sunken:rgba(237,237,237,.04);--line:rgba(237,237,237,.09);--ink:#EDEDED;--muted:#A1A1A6;
--primary:#FFB020;--fill:#FFB020;--on-fill:#1C1C1E;--soft:rgba(255,176,32,.14);--link:#FFC24D;--good:#4CC38A;--warn:#E2A336;--bad:#F0686C;--info:#6AA8F0;
--get:#4CC38A;--post:#E2A336;--put:#6AA8F0;--patch:#B59CFF;--delete:#F0686C;--k:#b59cff;--s:#4cc38a;--n:#e2a336;--l:#6aa8f0;
--shadow:0 12px 32px rgba(0,0,0,.5);color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--ink);font:400 14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
code,pre,.mono{font-family:ui-monospace,"JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace;font-size:12.5px}
.wrap{max-width:1280px;margin:0 auto;padding:16px;display:grid;gap:12px}
.glass{background:var(--panel);border:1px solid var(--line);border-radius:12px}
header.glass{padding:20px 24px;position:relative;overflow:hidden;border-top:3px solid var(--fill)}
.eyebrow{font-size:12.5px;font-weight:500;color:var(--muted);margin:0}
h1{font-size:24px;font-weight:600;line-height:1.2;margin:4px 0 8px;letter-spacing:-.01em}
.chips{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0 0}
.chip{font-size:12px;padding:2px 8px;border-radius:6px;background:var(--sunken);border:1px solid var(--line);color:var(--muted)}
.chip.v{background:var(--soft);color:var(--link);border-color:transparent;font-weight:600}
.desc{white-space:pre-wrap;margin:12px 0 0;max-width:80ch}
.tools{position:absolute;top:16px;right:16px;display:flex;gap:8px}
button{font:600 12.5px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:4px 12px;cursor:pointer}
button:hover{border-color:var(--primary)}button:focus-visible,a:focus-visible,input:focus-visible,pre:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.layout{display:grid;grid-template-columns:300px minmax(0,1fr);gap:12px;align-items:start}
.layout.single{grid-template-columns:minmax(0,1fr)}
nav.glass{padding:12px;position:sticky;top:12px;max-height:calc(100vh - 24px);display:flex;flex-direction:column;gap:8px}
nav input{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 8px}
nav ul{list-style:none;margin:0;padding:0;overflow:auto;display:grid;gap:2px}
nav .grp{font-size:12px;font-weight:600;color:var(--muted);padding:12px 8px 4px}
nav a{display:flex;gap:8px;align-items:center;padding:6px 8px;border-radius:8px;color:inherit;text-decoration:none;min-width:0}
nav a:hover{background:var(--sunken)}nav a[aria-current=true]{background:var(--soft)}
nav a span.nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.m{font:700 10px ui-monospace,Menlo,Consolas,monospace;min-width:2.8rem;flex:none;color:var(--muted)}
.m-GET{color:var(--get)}.m-POST{color:var(--post)}.m-PUT{color:var(--put)}.m-PATCH{color:var(--patch)}.m-DELETE{color:var(--delete)}
main.glass{padding:20px 24px;min-width:0}
.crumb{color:var(--muted);font-size:12.5px;margin:0}
h2{font-size:18px;font-weight:600;margin:4px 0 8px}
.docs{white-space:pre-wrap;color:var(--muted);margin:0 0 12px}
.urlrow{display:flex;gap:8px;align-items:center;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:0}
.urlrow code{flex:1;min-width:0;overflow-wrap:anywhere}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:16px 0 12px}
.tabs button{border:0;background:none;border-radius:0;padding:8px 12px;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs button:hover{color:var(--ink)}.tabs button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--primary)}
h3{font-size:13px;font-weight:600;color:var(--muted);margin:16px 0 8px}
table{border-collapse:collapse;width:100%;font-size:13px}td{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top;overflow-wrap:anywhere}
td:first-child{width:32%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;color:var(--muted)}
.pre{position:relative}.pre .btns{position:absolute;top:8px;right:8px;display:flex;gap:4px}.jtree{margin:0;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px 16px 12px 28px;overflow:auto;max-height:65vh;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.jl{white-space:pre-wrap;overflow-wrap:anywhere}.jk{padding-left:2ch}.jd>summary{list-style:none;cursor:pointer;position:relative;margin:0;color:inherit}.pre .btns button{position:static}.jd>summary::-webkit-details-marker{display:none}.jd>summary::before{content:'\\25BE';position:absolute;left:-1.3em;color:var(--muted)}.jd:not([open])>summary::before{content:'\\25B8'}.jd>summary:hover{background:var(--soft)}.jsum{display:none;color:var(--muted)}.jd:not([open])>summary .jsum{display:inline}
pre{margin:0;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px 16px;overflow:auto;max-height:65vh;white-space:pre-wrap;overflow-wrap:anywhere}
.pre button{position:absolute;top:8px;right:8px}
.k{color:var(--k)}.s{color:var(--s)}.n{color:var(--n)}.l{color:var(--l)}
.resps{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}.resps button[aria-pressed=true]{background:var(--soft);border-color:var(--primary)}
.status{font:700 13px ui-monospace,Menlo,Consolas,monospace;padding:2px 8px;border-radius:6px;border:1px solid currentColor}
.st2{color:var(--good)}.st3{color:var(--info)}.st4{color:var(--warn)}.st5{color:var(--bad)}
.resHead{display:flex;gap:12px;align-items:center;margin:0 0 8px}
details summary{cursor:pointer;color:var(--muted);margin:8px 0}
.empty{color:var(--muted)}
footer{color:var(--muted);font-size:12px;text-align:center;padding:4px 0 12px}
.toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--solid);border:1px solid var(--line);box-shadow:var(--shadow);padding:8px 16px;border-radius:8px;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.on{opacity:1}
@media (max-width:820px){.layout{grid-template-columns:minmax(0,1fr)}nav.glass{position:static;max-height:40vh}.tools{position:static;margin-bottom:8px}.wrap{padding:8px}}
@media print{.tools,nav,.pre button,.tabs{display:none}.jtree{max-height:none}.layout{display:block}.glass{border-color:#ddd}pre{max-height:none}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`

/* The page's script. Plain JS (no template literals) so it can sit in this file as a string. */
const JS = `
(function () {
  var doc = JSON.parse(document.getElementById('share-data').textContent);
  var $ = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var root = document.documentElement;
  var stored = null; try { stored = localStorage.getItem('share-theme'); } catch (e) {}
  root.dataset.theme = stored || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  var toastEl = $('div', 'toast'); toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl);
  var toastT;
  function toast(m) { toastEl.textContent = m; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('on'); }, 1600); }
  function copy(text, what) {
    function fallback() { var t = $('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); toast(what + ' copied'); } catch (e) { toast('Select the text and copy it'); } t.remove(); }
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast(what + ' copied'); }, fallback); else fallback();
  }
  function short(m) { return m === 'DELETE' ? 'DEL' : m === 'OPTIONS' ? 'OPT' : m; }
  function highlight(text) {
    var frag = document.createDocumentFragment();
    var t = (text || '').trim();
    if (!(t.charAt(0) === '{' || t.charAt(0) === '[')) { frag.appendChild(document.createTextNode(text)); return frag; }
    try { JSON.parse(t); } catch (e) { frag.appendChild(document.createTextNode(text)); return frag; }
    var re = /("(?:\\\\u[a-fA-F0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(?:true|false|null)\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var cls = m[0].charAt(0) === '"' ? (m[2] ? 'k' : 's') : /true|false|null/.test(m[0]) ? 'l' : 'n';
      frag.appendChild($('span', cls, m[0])); last = re.lastIndex;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }
  // JSON as a tree: every object and array folds (click its first line), with Collapse all and Expand all.
  function jnode(v, key, comma) {
    function label(el) { if (key != null) { el.appendChild($('span', 'k', JSON.stringify(key))); el.appendChild(document.createTextNode(': ')); } }
    var end = comma ? ',' : '';
    if (v === null || typeof v !== 'object') {
      var line = $('div', 'jl'); label(line);
      line.appendChild($('span', typeof v === 'string' ? 's' : typeof v === 'number' ? 'n' : 'l', JSON.stringify(v)));
      if (end) line.appendChild(document.createTextNode(end)); return line;
    }
    var arr = Array.isArray(v), keys = arr ? null : Object.keys(v), n = arr ? v.length : keys.length;
    var o = arr ? '[' : '{', c = arr ? ']' : '}';
    if (!n) { var e = $('div', 'jl'); label(e); e.appendChild(document.createTextNode(o + c + end)); return e; }
    var d = $('details', 'jd'); d.open = true;
    var sm = $('summary', 'jl'); label(sm); sm.appendChild(document.createTextNode(o));
    sm.appendChild($('span', 'jsum', '\u2026' + c + end + '  ' + n + (arr ? (n === 1 ? ' item' : ' items') : (n === 1 ? ' key' : ' keys'))));
    d.appendChild(sm);
    var kids = $('div', 'jk');
    for (var i = 0; i < n; i++) kids.appendChild(jnode(arr ? v[i] : v[keys[i]], arr ? null : keys[i], i < n - 1));
    d.appendChild(kids); d.appendChild($('div', 'jl', c + end)); return d;
  }
  function block(text, what) {
    var w = $('div', 'pre'), btns = $('span', 'btns'), data = null, t = (text || '').trim();
    if ((t.charAt(0) === '{' || t.charAt(0) === '[') && t.length < 2000000) { try { data = JSON.parse(t); } catch (e) { data = null; } }
    if (data !== null && typeof data === 'object') {
      var tree = $('div', 'jtree'); tree.tabIndex = 0; tree.appendChild(jnode(data, null, false)); w.appendChild(tree);
      function setAll(open) { Array.prototype.forEach.call(tree.querySelectorAll('details.jd'), function (d, i) { d.open = open || i === 0; }); }
      var ca = $('button', null, 'Collapse all'); ca.type = 'button'; ca.onclick = function () { setAll(false); };
      var ea = $('button', null, 'Expand all'); ea.type = 'button'; ea.onclick = function () { setAll(true); };
      btns.appendChild(ca); btns.appendChild(ea);
    } else { var p = $('pre'); p.tabIndex = 0; p.appendChild(highlight(text)); w.appendChild(p); }
    var b = $('button', null, 'Copy'); b.type = 'button'; b.setAttribute('aria-label', 'Copy ' + what.toLowerCase()); b.onclick = function () { copy(text, what); };
    btns.appendChild(b); w.appendChild(btns); return w;
  }
  function headerTable(list) {
    var t = $('table'); var body = $('tbody');
    list.forEach(function (h) { var tr = $('tr'); tr.appendChild($('td', null, h[0])); tr.appendChild($('td', null, h[1])); body.appendChild(tr); });
    t.appendChild(body); return t;
  }

  // Header
  var meta = doc.meta;
  document.title = meta.title + (meta.version ? ' ' + meta.version : '');
  var head = document.getElementById('head');
  var tools = $('div', 'tools');
  var themeBtn = $('button', null, root.dataset.theme === 'dark' ? 'Light' : 'Dark'); themeBtn.type = 'button'; themeBtn.setAttribute('aria-label', 'Switch light and dark');
  themeBtn.onclick = function () { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; themeBtn.textContent = root.dataset.theme === 'dark' ? 'Light' : 'Dark'; try { localStorage.setItem('share-theme', root.dataset.theme); } catch (e) {} };
  var printBtn = $('button', null, 'Print'); printBtn.type = 'button'; printBtn.onclick = function () { print(); };
  tools.appendChild(themeBtn); tools.appendChild(printBtn); head.appendChild(tools);
  head.appendChild($('p', 'eyebrow', doc.scope === 'request' ? 'Request' + (doc.collection ? ' · ' + doc.collection : '') : (doc.scope === 'folder' ? 'Folder of ' : 'Collection · ') + doc.collection));
  head.appendChild($('h1', null, meta.title));
  var chips = $('div', 'chips');
  if (meta.version) chips.appendChild($('span', 'chip v', 'v' + meta.version.replace(/^v/i, '')));
  chips.appendChild($('span', 'chip', doc.requests.length + (doc.requests.length === 1 ? ' request' : ' requests')));
  if (meta.author) chips.appendChild($('span', 'chip', 'By ' + meta.author));
  if (meta.contact) chips.appendChild($('span', 'chip', 'Contact: ' + meta.contact));
  chips.appendChild($('span', 'chip', 'Shared ' + new Date(doc.generatedAt).toLocaleString()));
  head.appendChild(chips);
  if (meta.description) head.appendChild($('p', 'desc', meta.description));

  // Navigation
  var layout = document.getElementById('layout');
  var nav = document.getElementById('nav');
  var links = [];
  if (doc.requests.length < 2) { nav.remove(); layout.classList.add('single'); }
  else {
    var search = $('input'); search.type = 'search'; search.placeholder = 'Search requests  /'; search.setAttribute('aria-label', 'Search requests');
    var list = $('ul'); nav.appendChild(search); nav.appendChild(list);
    var group = null;
    doc.requests.forEach(function (r, i) {
      var g = r.path.join(' / ');
      if (g !== group) { group = g; if (g) { var gl = $('li', 'grp', g); gl.dataset.group = g; list.appendChild(gl); } }
      var li = $('li'); var a = $('a'); a.href = '#r' + (i + 1); a.title = r.name;
      a.appendChild($('span', 'm m-' + r.method, short(r.method))); a.appendChild($('span', 'nm', r.name));
      li.appendChild(a); li.dataset.text = (r.name + ' ' + r.url + ' ' + r.method + ' ' + g).toLowerCase(); li.dataset.group = g; list.appendChild(li); links.push(a);
    });
    search.oninput = function () {
      var q = search.value.trim().toLowerCase(); var seen = {};
      Array.prototype.forEach.call(list.children, function (li) { if (li.className !== 'grp') { var on = !q || li.dataset.text.indexOf(q) >= 0; li.hidden = !on; if (on) seen[li.dataset.group] = true; } });
      Array.prototype.forEach.call(list.querySelectorAll('.grp'), function (g) { g.hidden = !seen[g.dataset.group]; });
    };
    addEventListener('keydown', function (e) { if (e.key === '/' && document.activeElement !== search) { e.preventDefault(); search.focus(); } });
  }

  // One request
  var main = document.getElementById('main');
  var tabNow = doc.open || 'request';
  function show(i) {
    var r = doc.requests[i]; if (!r) return;
    links.forEach(function (a, j) { a.setAttribute('aria-current', j === i ? 'true' : 'false'); });
    main.textContent = '';
    if (r.path.length || doc.collection) main.appendChild($('p', 'crumb', [doc.collection].concat(r.path).filter(Boolean).join(' / ')));
    main.appendChild($('h2', null, r.name));
    if (r.docs) main.appendChild($('p', 'docs', r.docs));
    var row = $('div', 'urlrow'); row.appendChild($('span', 'm m-' + r.method, short(r.method))); row.appendChild($('code', null, r.url));
    var cu = $('button', null, 'Copy URL'); cu.type = 'button'; cu.onclick = function () { copy(r.url, 'URL'); }; row.appendChild(cu); main.appendChild(row);
    var tabs = $('div', 'tabs'); tabs.setAttribute('role', 'tablist'); var panel = $('div'); panel.setAttribute('role', 'tabpanel');
    var defs = [['request', 'Request'], ['response', 'Response' + (r.responses.length > 1 ? ' (' + r.responses.length + ')' : '')], ['curl', 'curl']];
    function pick(id) {
      tabNow = id; panel.textContent = '';
      Array.prototype.forEach.call(tabs.children, function (b) { b.setAttribute('aria-selected', String(b.dataset.id === id)); });
      if (id === 'request') {
        if (r.headers.length) { panel.appendChild($('h3', null, 'Headers')); panel.appendChild(headerTable(r.headers)); }
        if (r.body) { panel.appendChild($('h3', null, 'Body' + (r.bodyKind && r.bodyKind !== 'none' ? ' (' + r.bodyKind + ')' : ''))); panel.appendChild(block(r.body, 'Body')); }
        if (!r.headers.length && !r.body) panel.appendChild($('p', 'empty', 'No headers or body.'));
      } else if (id === 'response') {
        if (!r.responses.length) { panel.appendChild($('p', 'empty', 'No sample response was included.')); return; }
        var bar = $('div', 'resps'); var holder = $('div');
        function showResp(k) {
          var x = r.responses[k]; holder.textContent = '';
          Array.prototype.forEach.call(bar.children, function (b, j) { b.setAttribute('aria-pressed', String(j === k)); });
          var rh = $('div', 'resHead'); rh.appendChild($('span', 'status st' + String(x.status).charAt(0), x.status + (x.statusText ? ' ' + x.statusText : '')));
          rh.appendChild($('span', 'chip', x.label));
          if (x.timeMs != null) rh.appendChild($('span', 'chip', x.timeMs + ' ms'));
          holder.appendChild(rh);
          if (x.headers.length) { var d = $('details'); d.appendChild($('summary', null, 'Headers (' + x.headers.length + ')')); d.appendChild(headerTable(x.headers)); holder.appendChild(d); }
          holder.appendChild(x.body ? block(x.body, 'Response') : $('p', 'empty', 'Empty body.'));
        }
        r.responses.forEach(function (x, k) { var b = $('button', null, x.label + ' · ' + x.status); b.type = 'button'; b.onclick = function () { showResp(k); }; bar.appendChild(b); });
        if (r.responses.length > 1) panel.appendChild(bar);
        panel.appendChild(holder); showResp(0);
      } else {
        panel.appendChild(block(r.curl, 'curl'));
      }
    }
    defs.forEach(function (d) { var b = $('button', null, d[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.id = d[0]; b.onclick = function () { pick(d[0]); }; tabs.appendChild(b); });
    main.appendChild(tabs); main.appendChild(panel); pick(tabNow);
  }
  function fromHash() { var m = /^#r(\\d+)$/.exec(location.hash); var i = m ? Number(m[1]) - 1 : 0; show(i >= 0 && i < doc.requests.length ? i : 0); }
  addEventListener('hashchange', fromHash);
  if (!doc.requests.length) main.appendChild($('p', 'empty', 'No requests.')); else fromHash();

  document.getElementById('foot').textContent = 'Shared from Dispatch on ' + new Date(doc.generatedAt).toLocaleDateString() + '. '
    + (doc.redactions ? doc.redactions + (doc.redactions === 1 ? ' value that looked secret or personal was' : ' values that looked secret or personal were') + ' replaced. ' : '')
    + 'Variables are shown as {{name}}' + (doc.options.server ? ', and the server address as ' + doc.options.server : '') + '.'
    + (doc.options.trimmed ? ' Long lists and texts are cut to a sample.' : '');
})();
`

/** The whole page as a string, ready to save as .html. */
export function renderShareHtml(doc: ShareDoc): string {
  const title = esc(doc.meta.title + (doc.meta.version ? ` ${doc.meta.version}` : ''))
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="generator" content="Dispatch">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="glass" id="head"></header>
<div class="layout" id="layout">
<nav class="glass" id="nav" aria-label="Requests"></nav>
<main class="glass" id="main"></main>
</div>
<footer id="foot"></footer>
</div>
<noscript><p style="padding:16px">This page needs JavaScript to show the requests.</p></noscript>
<script type="application/json" id="share-data">${embed(doc)}</script>
<script>${JS}</script>
</body>
</html>
`
}
