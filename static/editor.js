// CV editor UI: edits the CV data, keeps an undo history and streams changes to the preview iframe.
(function () {
  "use strict";

  const SECTION_TYPES = {
    entries: { label: "Entries (jobs, education)", addLabel: "Add entry",
      newItem: () => ({ title: "", titleRight: "", subtitle: "", subtitleRight: "", bullets: [] }) },
    projects: { label: "Projects", addLabel: "Add project",
      newItem: () => ({ name: "", tech: "", link: "", description: "", bullets: [] }) },
    skills: { label: "Skills table", addLabel: "Add row", newItem: () => ({ label: "", value: "" }) },
    list: { label: "Bullet list", addLabel: "Add bullet", newItem: () => "" },
    text: { label: "Paragraph (e.g. summary)" },
  };

  const $ = (id) => document.getElementById(id);
  const formEl = $("form"), frame = $("frame"), frameWrap = $("frameWrap");

  let cv = null;            // current CV data
  let savedJSON = "";       // what's on disk
  let lastSnap = "";        // JSON of cv after the last recorded change
  let undoStack = [], redoStack = [];
  let typingBurst = false, burstTimer = 0;
  let previewReady = false, previewQueued = false;
  let docHeight = 1200;
  let layoutInfo = null;    // latest page measurement from the preview
  let zoom = "fit";
  const collapsed = new WeakSet();

  // ---------- tiny DOM helper ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = v;
      else if (k === "value") el.value = v;
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  }

  function autoGrow(t) { t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px"; }

  // A text input / textarea bound to obj[key]. `key` path identifies it so focus survives re-renders.
  function bound(obj, key, { multiline = false, placeholder = "", path, onKey } = {}) {
    const attrs = {
      value: obj[key] == null ? "" : String(obj[key]),
      placeholder, "data-path": path, spellcheck: "true",
      oninput: (e) => { obj[key] = e.target.value; if (multiline) autoGrow(e.target); changed(false); },
      onkeydown: onKey,
    };
    if (multiline) { attrs.rows = 1; return h("textarea", attrs); }
    attrs.type = "text";
    return h("input", attrs);
  }

  function field(label, input) { return h("label", { class: "field" }, h("span", {}, label), input); }

  function iconBtn(text, title, onclick, extra = "") {
    return h("button", { type: "button", class: "icon " + extra, title, onclick }, text);
  }

  function move(arr, i, d) {
    const j = i + d;
    if (j < 0 || j >= arr.length) return false;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    return true;
  }

  function rowTools(arr, i, { dup = false, horizontal = false, path } = {}) {
    return h("div", { class: "rowTools" + (horizontal ? " h" : "") },
      iconBtn("↑", "Move up", () => { if (move(arr, i, -1)) changed(true, path && path(i - 1)); }),
      iconBtn("↓", "Move down", () => { if (move(arr, i, 1)) changed(true, path && path(i + 1)); }),
      dup && iconBtn("⧉", "Duplicate", () => { arr.splice(i + 1, 0, JSON.parse(JSON.stringify(arr[i]))); changed(true); }),
      iconBtn("✕", "Remove", () => { arr.splice(i, 1); changed(true); }, "danger"),
    );
  }

  // Editable list of strings (bullets). Enter adds a bullet below, Backspace on an empty one removes it.
  // `ai` (optional) = { label, entry } describes what these bullets belong to, for the AI helper.
  function bulletList(arr, path, addLabel = "Add bullet", ai = null) {
    const wrap = h("div", { class: "bullets" });
    arr.forEach((_, i) => {
      const p = `${path}.${i}`;
      const onKey = (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
          e.preventDefault();
          const t = e.target, before = t.value.slice(0, t.selectionStart), after = t.value.slice(t.selectionEnd);
          arr[i] = before.trimEnd();
          arr.splice(i + 1, 0, after.trimStart());
          changed(true, `${path}.${i + 1}`, 0);
        } else if (e.key === "Backspace" && e.target.value === "" && arr.length > 0) {
          e.preventDefault();
          arr.splice(i, 1);
          changed(true, i > 0 ? `${path}.${i - 1}` : null, "end");
        }
      };
      wrap.append(h("div", { class: "bulletRow" },
        h("span", { class: "dot" }, "•"),
        bound(arr, i, { multiline: true, path: p, onKey, placeholder: "Describe an achievement…" }),
        ai && iconBtn("✨", "Improve this bullet with AI", () => {
          if (!String(arr[i]).trim()) { toast("Write something first, then let AI improve it.", true); return; }
          openAI({ mode: "improve", label: ai.label, entry: ai.entry, text: arr[i],
            onApply: ([t]) => { arr[i] = t; changed(true); } });
        }, "ai"),
        i < arr.length - 1 && iconBtn("⤵", "Merge with the next bullet", () => {
          const first = String(arr[i]).trim().replace(/[.;,]\s*$/, ""), second = String(arr[i + 1]).trim();
          arr[i] = first && second ? `${first}; ${second}` : first || second;
          arr.splice(i + 1, 1);
          changed(true, `${path}.${i}`, first && second ? first.length + 2 : "end"); // caret at the join
        }),
        rowTools(arr, i, { horizontal: true, path: (j) => `${path}.${j}` })));
    });
    const addBtn = h("button", { type: "button", class: "add", onclick: () => { arr.push(""); changed(true, `${path}.${arr.length - 1}`); } }, "+ " + addLabel);
    wrap.append(ai ? h("div", { class: "addRow" }, addBtn, h("button", { type: "button", class: "add ai",
      title: "Turn rough notes into bullet points",
      onclick: () => openAI({ mode: "bullets", label: ai.label, entry: ai.entry, notesKey: arr,
        onApply: (list) => { arr.push(...list); changed(true); } }) }, "✨ Write with AI")) : addBtn);
    return wrap;
  }

  // ---------- form ----------
  function renderForm(focusPath, caret) {
    const active = document.activeElement;
    const keepPath = focusPath !== undefined ? focusPath : active && active.dataset ? active.dataset.path : null;
    const selStart = active && "selectionStart" in active ? active.selectionStart : null;
    const scroll = formEl.scrollTop;

    formEl.replaceChildren(headerCard(), layoutCard(), ...cv.sections.map(sectionCard), addSectionCard(), helpCard());

    formEl.scrollTop = scroll;
    formEl.querySelectorAll("textarea").forEach(autoGrow);
    if (keepPath) {
      const el = formEl.querySelector(`[data-path="${CSS.escape(keepPath)}"]`);
      if (el) {
        el.focus({ preventScroll: focusPath === undefined });
        const pos = typeof caret === "number" ? caret : caret === "end" ? el.value.length : focusPath === undefined ? selStart : el.value.length;
        if (pos != null) try { el.setSelectionRange(pos, pos); } catch (e) { /* not a text field */ }
      }
    }
  }

  function headerCard() {
    if (!Array.isArray(cv.contacts)) cv.contacts = [];
    const contacts = h("div", {});
    cv.contacts.forEach((_, i) => contacts.append(h("div", { class: "bulletRow" },
      bound(cv.contacts, i, { path: `contacts.${i}`, placeholder: "e.g. City, email, phone, LinkedIn…" }),
      rowTools(cv.contacts, i, { horizontal: true, path: (j) => `contacts.${j}` }))));
    contacts.append(h("button", { type: "button", class: "add",
      onclick: () => { cv.contacts.push(""); changed(true, `contacts.${cv.contacts.length - 1}`); } }, "+ Add contact"));
    return card("header", "Header", null, [
      field("Full name", bound(cv, "name", { path: "name" })),
      field("Headline under the name (optional, e.g. the position you want)", h("div", { class: "withAi" },
        bound(cv, "headline", { path: "headline", placeholder: "e.g. Python Backend Developer" }),
        iconBtn("✨", "Suggest a headline with AI", () => openAI({ mode: "headline", label: "Headline",
          text: cv.headline || "", onApply: ([t]) => { cv.headline = t; changed(true); } }), "ai"))),
      h("div", { class: "listHead" }, "Contact line (items are separated with “·”)"),
      contacts,
    ]);
  }

  function layoutCard() {
    cv.style = cv.style || {};
    const st = cv.style;
    const fs = h("input", { type: "number", min: 7, max: 13, step: 0.1, value: st.fontSize || 9.96, "data-path": "style.fontSize",
      oninput: (e) => { const v = parseFloat(e.target.value); if (v >= 6 && v <= 14) { st.fontSize = v; changed(false); } } });
    const out = h("output", {}, Math.round((st.spacing == null ? 1 : st.spacing) * 100) + "%");
    const sp = h("input", { type: "range", min: 0, max: 2, step: 0.05, value: st.spacing == null ? 1 : st.spacing, "data-path": "style.spacing",
      oninput: (e) => { st.spacing = parseFloat(e.target.value); out.value = Math.round(st.spacing * 100) + "%"; changed(false); } });
    return card("layout", "Page & export", null, [
      field("PDF file name", bound(cv, "fileName", { path: "fileName", placeholder: "e.g. Firstname_Lastname_CV" })),
      h("div", { class: "grid2" },
        field("Font size (pt) — original 9.96", fs),
        field("Vertical spacing", h("div", { class: "rangeRow" }, sp, out))),
      h("button", { type: "button", onclick: () => { cv.style = {}; changed(true); } }, "Reset to original layout"),
    ]);
  }

  function card(key, title, headExtras, body, obj) {
    const target = obj || cv;
    const isCollapsed = obj ? collapsed.has(obj) : false;
    const c = h("div", { class: "card" + (isCollapsed ? " collapsed" : "") + (obj && obj.hidden ? " hiddenSec" : "") });
    const caret = obj ? iconBtn(isCollapsed ? "▸" : "▾", "Collapse / expand", () => {
      if (collapsed.has(target)) collapsed.delete(target); else collapsed.add(target);
      renderForm();
    }, "caret") : null;
    c.append(h("div", { class: "cardHead" }, caret, typeof title === "string" ? h("div", { class: "headTitle" }, title) : title, headExtras),
      h("div", { class: "cardBody" }, body));
    return c;
  }

  function sectionCard(sec, si) {
    const type = SECTION_TYPES[sec.type] ? sec.type : "text";
    const spec = SECTION_TYPES[type];
    const p = `s${si}`;
    const titleInput = bound(sec, "title", { path: `${p}.title`, placeholder: "Section title" });
    titleInput.classList.add("headTitle");
    const extras = [
      h("span", { class: "badge" }, spec.label.replace(/ \(.*\)/, "")),
      iconBtn(sec.hidden ? "Show" : "Hide", sec.hidden ? "Show this section in the CV" : "Hide this section from the CV (keeps the content)",
        () => { sec.hidden = !sec.hidden; changed(true); }),
      iconBtn("↑", "Move section up", () => { if (move(cv.sections, si, -1)) changed(true); }),
      iconBtn("↓", "Move section down", () => { if (move(cv.sections, si, 1)) changed(true); }),
      iconBtn("✕", "Delete section", () => {
        if (confirm(`Delete the section “${sec.title || "Untitled"}”? (You can undo this.)`)) { cv.sections.splice(si, 1); changed(true); }
      }, "danger"),
    ];

    let body = [];
    if (type === "text") {
      body = [bound(sec, "text", { multiline: true, path: `${p}.text`, placeholder: "A few sentences. Leave an empty line between paragraphs." })];
    } else {
      if (!Array.isArray(sec.items)) sec.items = [];
      const items = sec.items;
      if (type === "entries") {
        body.push(h("label", { class: "check" },
          h("input", { type: "checkbox", checked: !!sec.italicSubtitle, onchange: (e) => { sec.italicSubtitle = e.target.checked; changed(true); } }),
          "Second line in italics"));
        items.forEach((it, i) => {
          if (!Array.isArray(it.bullets)) it.bullets = [];
          const ip = `${p}.${i}`;
          body.push(itemBox(items, i, `${p}`, [
            h("div", { class: "grid2" },
              field("Organization / school (bold)", bound(it, "title", { path: `${ip}.title` })),
              field("Right of first line (e.g. city)", bound(it, "titleRight", { path: `${ip}.titleRight` })),
              field("Role / degree", bound(it, "subtitle", { path: `${ip}.subtitle` })),
              field("Dates", bound(it, "subtitleRight", { path: `${ip}.subtitleRight`, placeholder: "e.g. Feb 2024 – Present" }))),
            h("div", { class: "listHead" }, "Bullet points"),
            bulletList(it.bullets, `${ip}.b`, "Add bullet", { label: [it.title, it.subtitle].filter(Boolean).join(" — ") || sec.title, entry: it }),
          ]));
        });
      } else if (type === "projects") {
        items.forEach((it, i) => {
          if (!Array.isArray(it.bullets)) it.bullets = [];
          const ip = `${p}.${i}`;
          body.push(itemBox(items, i, p, [
            h("div", { class: "grid2" },
              field("Project name (bold)", bound(it, "name", { path: `${ip}.name` })),
              field("Link (optional, makes the name clickable)", bound(it, "link", { path: `${ip}.link`, placeholder: "github.com/…" }))),
            field("Technologies (slanted)", bound(it, "tech", { path: `${ip}.tech` })),
            field("Description", bound(it, "description", { multiline: true, path: `${ip}.description` })),
            it.bullets.length ? h("div", { class: "listHead" }, "Bullet points") : null,
            bulletList(it.bullets, `${ip}.b`, "Add bullet", { label: it.name || sec.title, entry: it }),
          ]));
        });
      } else if (type === "skills") {
        items.forEach((it, i) => body.push(h("div", { class: "skillRow" },
          bound(it, "label", { path: `${p}.${i}.label`, placeholder: "Category:" }),
          bound(it, "value", { multiline: true, path: `${p}.${i}.value`, placeholder: "Skill, skill, skill" }),
          rowTools(items, i, { horizontal: true, path: (j) => `${p}.${j}.label` }))));
      } else if (type === "list") {
        body.push(bulletList(items, `${p}.b`, "Add bullet", { label: sec.title, entry: { section: sec.title, items } }));
      }
      if (type !== "list") {
        body.push(h("button", { type: "button", class: "add", onclick: () => {
          items.push(spec.newItem());
          const n = items.length - 1;
          changed(true, type === "skills" ? `${p}.${n}.label` : type === "projects" ? `${p}.${n}.name` : `${p}.${n}.title`);
        } }, "+ " + spec.addLabel));
      }
    }
    return card(p, titleInput, extras, body, sec);
  }

  function itemBox(items, i, p, children) {
    return h("div", { class: "item" },
      h("div", { class: "itemHead" }, h("span", { class: "itemLabel" }, `#${i + 1}`),
        rowTools(items, i, { dup: true, horizontal: true })),
      children);
  }

  function addSectionCard() {
    const sel = h("select", {}, Object.entries(SECTION_TYPES).map(([k, v]) => h("option", { value: k }, v.label)));
    return h("div", { class: "addSection" }, sel, h("button", { type: "button", onclick: () => {
      const type = sel.value;
      const sec = { title: "New section", type };
      if (type === "text") sec.text = "";
      else sec.items = type === "list" ? [""] : [SECTION_TYPES[type].newItem()];
      if (type === "entries") sec.italicSubtitle = true;
      cv.sections.push(sec);
      changed(true, `s${cv.sections.length - 1}.title`);
    } }, "+ Add section"));
  }

  function helpCard() {
    return h("p", { class: "hint", style: "margin-top:16px" },
      "Formatting inside any text: ", h("code", {}, "**bold**"), ", ", h("code", {}, "*italic*"), ", ",
      h("code", {}, "[link text](https://…)"), ". In bullet points, Enter starts a new bullet and Shift+Enter breaks the line. ",
      "Ctrl+S saves, Ctrl+E exports the PDF.");
  }

  // ---------- state & history ----------
  function changed(structural, focusPath, caret) {
    const now = JSON.stringify(cv);
    if (now !== lastSnap) {
      if (structural || !typingBurst) {
        undoStack.push(lastSnap);
        if (undoStack.length > 300) undoStack.shift();
        redoStack = [];
      }
      lastSnap = now;
    }
    typingBurst = !structural;
    clearTimeout(burstTimer);
    burstTimer = setTimeout(() => { typingBurst = false; }, 900);
    if (structural) renderForm(focusPath, caret);
    afterChange();
  }

  // Make sure every list the form edits exists, so rendering the form never changes the data.
  function normalize(d) {
    if (!Array.isArray(d.sections)) d.sections = [];
    if (!Array.isArray(d.contacts)) d.contacts = [];
    if (!d.style || typeof d.style !== "object") d.style = {};
    for (const s of d.sections) {
      if (!SECTION_TYPES[s.type] || s.type === "text") { s.type = "text"; if (typeof s.text !== "string") s.text = ""; continue; }
      if (!Array.isArray(s.items)) s.items = [];
      if (s.type === "entries" || s.type === "projects") {
        s.items.forEach((it) => { if (!Array.isArray(it.bullets)) it.bullets = []; });
      }
    }
    return d;
  }

  function restore(json) {
    cv = normalize(JSON.parse(json));
    json = JSON.stringify(cv);
    lastSnap = json;
    typingBurst = false;
    renderForm(null);
    afterChange();
  }

  function undo() { if (!undoStack.length) return; redoStack.push(lastSnap); restore(undoStack.pop()); }
  function redo() { if (!redoStack.length) return; undoStack.push(lastSnap); restore(redoStack.pop()); }

  function isDirty() { return JSON.stringify(cv) !== savedJSON; }

  function afterChange() {
    $("undo").disabled = !undoStack.length;
    $("redo").disabled = !redoStack.length;
    const st = $("status");
    if (isDirty()) { st.textContent = "Unsaved changes"; st.className = "status dirty"; }
    else { st.textContent = "All changes saved"; st.className = "status saved"; }
    sendPreview();
  }

  // ---------- preview ----------
  function sendPreview() {
    if (!previewReady || previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => {
      previewQueued = false;
      frame.contentWindow.postMessage({ type: "cv-data", cv }, "*");
    });
  }

  const FRAME_W = Math.ceil(595.28 * 4 / 3) + 48;
  function applyZoom() {
    const z = zoom === "fit" ? Math.max(0.3, Math.min(2, (frameWrap.clientWidth - 16) / FRAME_W)) : zoom;
    const sizer = frame.parentElement;
    sizer.style.width = FRAME_W * z + "px";
    sizer.style.height = docHeight * z + "px";
    frame.style.width = FRAME_W + "px";
    frame.style.height = docHeight + "px";
    frame.style.transform = `scale(${z})`;
    $("zoomLabel").textContent = Math.round(z * 100) + "%";
    try { localStorage.setItem("cv-editor-zoom", String(zoom)); } catch (e) { /* storage unavailable */ }
  }
  function zoomBy(f) {
    const cur = zoom === "fit" ? parseFloat($("zoomLabel").textContent) / 100 : zoom;
    zoom = Math.max(0.3, Math.min(2, Math.round(cur * f * 20) / 20));
    applyZoom();
  }

  window.addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow || !e.data) return;
    if (e.data.type === "cv-preview-ready") {
      previewReady = true;
      frame.contentWindow.postMessage({ type: "ui-theme", theme: currentTheme() }, "*");
      if (cv) sendPreview();
    }
    if (e.data.type === "cv-measured") {
      layoutInfo = { pages: e.data.pages, freeFrac: e.data.freeFrac };
      if (e.data.docHeight && Math.abs(e.data.docHeight - docHeight) > 1) { docHeight = e.data.docHeight; applyZoom(); }
      const pg = $("pages");
      if (e.data.pages > 1) {
        pg.textContent = `${e.data.pages} pages`;
        pg.className = "pages over";
        pg.title = "The CV no longer fits on one page. Shorten text, lower the font size, or reduce spacing in “Page & export”.";
      } else {
        pg.textContent = `1 page · ${Math.max(0, Math.round(e.data.freeFrac * 100))}% free`;
        pg.className = "pages";
        pg.title = "How much empty space is left at the bottom of the page";
      }
    }
  });

  // ---------- server ----------
  function toast(msg, isError, html) {
    const t = $("toast");
    t.className = "toast" + (isError ? " error" : "");
    if (html) t.innerHTML = html; else t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 8000 : 5000);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  async function save() {
    try {
      const snapshot = JSON.stringify(cv);
      await api("PUT", "/api/cv", cv);
      savedJSON = snapshot;
      afterChange();
      toast("Saved");
    } catch (e) {
      toast("Could not save: " + e.message + " (is server.py still running?)", true);
    }
  }

  async function exportPdf() {
    const btn = $("export");
    btn.disabled = true;
    btn.textContent = "Exporting…";
    try {
      const snapshot = JSON.stringify(cv);
      const res = await api("POST", "/api/export", cv);
      savedJSON = snapshot;
      afterChange();
      const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      toast("", false, `PDF saved: ${esc(res.path)} — <a href="${esc(res.url)}" target="_blank">open it</a>`);
    } catch (e) {
      toast("Export failed: " + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Export PDF";
    }
  }

  async function showHistory() {
    const list = $("historyList");
    list.replaceChildren(h("li", { class: "hint" }, "Loading…"));
    $("historyDialog").showModal();
    try {
      const names = await api("GET", "/api/backups");
      list.replaceChildren(...(names.length ? names.map((n) => {
        const m = n.match(/cv-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
        const label = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : n;
        return h("li", {}, h("button", { type: "button", onclick: async () => {
          try {
            const data = await api("GET", "/api/backup/" + encodeURIComponent(n));
            undoStack.push(lastSnap); redoStack = [];
            restore(JSON.stringify(data));
            $("historyDialog").close();
            toast(`Loaded version from ${label}. Save to keep it, or Undo to go back.`);
          } catch (e) { toast("Could not load: " + e.message, true); }
        } }, "Version that was current until " + label));
      }) : [h("li", { class: "hint" }, "No earlier versions yet — they appear after you save changes.")]));
    } catch (e) {
      list.replaceChildren(h("li", { class: "hint" }, "Could not load history: " + e.message));
    }
  }

  // ---------- AI assistant ----------
  const aiNotes = new WeakMap(); // remembers notes typed for each bullet list while the editor is open
  let aiReq = null;
  let aiStatus = null;

  function aiShowSettings(show) {
    $("aiKeyBox").hidden = !show;
    $("aiMain").hidden = show;
    if (!show || !aiStatus) return;
    const st = aiStatus;
    $("aiKeyIntro").replaceChildren(...(st.backend === "claude-code"
      ? [h("b", {}, "No API key needed."), " The AI helper uses Claude Code, which is installed and signed in on this computer, so suggestions count toward your Claude subscription."]
      : st.backend === "api"
        ? [h("b", {}, "Using your Anthropic API key."), " Remove it to use your Claude Code login instead, if Claude Code is installed."]
        : [h("b", {}, "The AI helper can't reach Claude yet."), " The easiest fix is to install Claude Code and sign in once by running ",
           h("code", {}, "claude"), " in a terminal. Then restart the editor. Or add an API key below."]));
    $("aiKeyRemove").hidden = st.keySource !== "file";
    $("aiKeyBack").hidden = !st.configured;
  }

  async function aiRefreshStatus() {
    aiStatus = await api("GET", "/api/ai/status");
    aiFillModels(aiStatus);
    $("aiBackend").textContent = aiStatus.backend === "claude-code" ? "Using your Claude Code login"
      : aiStatus.backend === "api" ? "Using your API key" : "Not connected";
    return aiStatus;
  }

  async function openAI(req) {
    aiReq = req;
    const titles = { bullets: "Write bullet points with AI", improve: "Improve a bullet point", headline: "Suggest a headline" };
    $("aiTitle").textContent = "✨ " + titles[req.mode];
    $("aiContext").replaceChildren(...(req.mode === "improve"
      ? ["For ", h("b", {}, req.label || "this entry"), ". Current text: “" + req.text + "”"]
      : req.mode === "headline"
        ? ["Based on the rest of your CV. Enter the position you're aiming for if you like."]
        : ["For ", h("b", {}, req.label || "this entry"), ". The AI also sees the rest of your CV."]));
    $("aiNotesField").hidden = req.mode === "improve";
    $("aiNotesLabel").textContent = req.mode === "headline"
      ? "Position you're looking for (optional)"
      : "What did you do there? Rough notes in any language are fine.";
    $("aiNotes").value = req.mode === "bullets" ? (aiNotes.get(req.notesKey) || "") : req.mode === "headline" ? (req.text || "") : "";
    $("aiNotes").placeholder = req.mode === "bullets"
      ? "e.g. made REST API on FastAPI for orders, wrote tests with pytest, set up Docker, sped up slow SQL queries"
      : "e.g. Junior Python developer, backend";
    $("aiCount").value = req.mode === "bullets" ? "4" : "3";
    $("aiExtra").value = "";
    $("aiResults").replaceChildren();
    $("aiApply").hidden = true;
    $("aiGo").textContent = "Generate";
    $("aiDialog").showModal();
    try {
      const st = await aiRefreshStatus();
      aiShowSettings(!st.configured);
      if (st.configured) (req.mode === "improve" ? $("aiGo") : $("aiNotes")).focus();
    } catch (e) {
      $("aiResults").replaceChildren(h("div", { class: "aiStatus error" }, "Could not reach the editor server: " + e.message));
    }
  }

  async function aiGenerate() {
    const req = aiReq;
    if (!req) return;
    const notes = $("aiNotes").value;
    if (req.mode === "bullets") aiNotes.set(req.notesKey, notes);
    const body = {
      mode: req.mode, cv, count: parseInt($("aiCount").value, 10), instructions: $("aiExtra").value.trim(),
      model: $("aiModel").value, private: privacyOn(),
      entry: req.entry || null,
      text: req.mode === "improve" ? req.text : notes,
    };
    if (req.mode === "headline" && notes.trim()) body.cv = Object.assign({}, cv, { headline: notes.trim() });
    const go = $("aiGo");
    go.disabled = true;
    go.textContent = "Thinking…";
    $("aiApply").hidden = true;
    $("aiResults").replaceChildren(h("div", { class: "aiStatus" }, "Asking Claude… this usually takes 5–20 seconds."));
    try {
      const res = await api("POST", "/api/ai", body);
      if (aiReq !== req) return; // dialog was reopened for something else meanwhile
      aiRenderResults(req, res.suggestions || []);
    } catch (e) {
      $("aiResults").replaceChildren(h("div", { class: "aiStatus error" }, e.message));
    } finally {
      go.disabled = false;
      go.textContent = "Generate again";
    }
  }

  function aiRenderResults(req, list) {
    if (!list.length) {
      $("aiResults").replaceChildren(h("div", { class: "aiStatus" }, "No suggestions came back. Try adding more detail."));
      return;
    }
    const multi = req.mode === "bullets";
    const rows = list.map((text) => {
      const ta = h("textarea", { rows: 1, value: text, title: "You can edit the suggestion before using it" });
      ta.addEventListener("input", () => autoGrow(ta));
      const row = h("div", { class: "aiSug" + (multi ? " picked" : "") });
      if (multi) {
        const cb = h("input", { type: "checkbox", checked: true, onchange: () => row.classList.toggle("picked", cb.checked) });
        row.append(cb, ta);
        row._get = () => (cb.checked ? ta.value.trim() : "");
      } else {
        row.append(ta, h("button", { type: "button", class: "primary", onclick: () => aiApply([ta.value.trim()]) }, "Use"));
      }
      row._ta = ta;
      return row;
    });
    $("aiResults").replaceChildren(...rows);
    rows.forEach((r) => autoGrow(r._ta));
    $("aiApply").hidden = !multi;
    $("aiApply").onclick = () => aiApply(rows.map((r) => r._get()).filter(Boolean));
  }

  function aiApply(values) {
    values = values.filter(Boolean);
    if (!values.length || !aiReq) return;
    aiReq.onApply(values);
    $("aiDialog").close();
    toast(values.length > 1 ? `Added ${values.length} bullet points. Undo removes them.` : "Applied. Undo restores the previous text.");
  }

  $("aiGo").onclick = aiGenerate;
  $("aiClose").onclick = () => $("aiDialog").close();
  $("aiNotes").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) aiGenerate(); });
  $("aiChangeKey").onclick = (e) => { e.preventDefault(); $("aiKey").value = ""; aiShowSettings(true); };
  $("aiKeyBack").onclick = () => aiShowSettings(false);
  async function aiSetKey(key, msg) {
    try {
      await api("POST", "/api/ai/key", { key });
      $("aiKey").value = "";
      const st = await aiRefreshStatus();
      aiShowSettings(!st.configured);
      toast(msg);
    } catch (e) { toast(e.message, true); }
  }
  $("aiKeySave").onclick = () => {
    if (!$("aiKey").value.trim()) { toast("Paste a key first.", true); return; }
    aiSetKey($("aiKey").value, "API key saved.");
  };
  $("aiKeyRemove").onclick = () => aiSetKey("", "API key removed.");

  // ---------- model choice ----------
  const MODEL_HINTS = {
    "claude-haiku-5-5": "fast, light on usage",
    "claude-sonnet-5-5": "balanced",
    "claude-opus-5-5": "most capable, heaviest on usage",
  };

  function storedModel(kind) {
    try { return localStorage.getItem("cv-ai-model-" + kind); } catch (e) { return null; }
  }

  function aiFillModels(st) {
    for (const sel of [$("aiModel"), $("reviewModel"), $("proofModel")]) {
      const kind = sel.dataset.kind;
      const def = st.defaults[kind];
      const want = storedModel(kind);
      sel.replaceChildren(...Object.entries(st.models).map(([id, name]) =>
        h("option", { value: id }, `${name} (${MODEL_HINTS[id] || ""}${id === def ? ", recommended" : ""})`)));
      sel.value = want && st.models[want] ? want : def;
    }
  }
  for (const sel of [$("aiModel"), $("reviewModel"), $("proofModel")]) {
    sel.addEventListener("change", () => {
      try { localStorage.setItem("cv-ai-model-" + sel.dataset.kind, sel.value); } catch (e) { /* storage unavailable */ }
    });
  }

  // ---------- CV review ----------
  let lastReview = null;

  // Field ids from the review ("s0.1.b.2", "headline", ...) -> [container, key] in the current CV.
  function resolvePath(path) {
    const parts = String(path || "").split(".");
    let target = null;
    if (parts[0] === "name" || parts[0] === "headline") target = [cv, parts[0]];
    else if (parts[0] === "contacts") target = [cv.contacts, +parts[1]];
    else {
      const m = /^s(\d+)$/.exec(parts[0]);
      const sec = m && cv.sections[+m[1]];
      if (!sec) return null;
      if (parts.length === 2) target = [sec, parts[1]];
      else if (parts[1] === "b") target = [sec.items, +parts[2]];
      else {
        const item = sec.items && sec.items[+parts[1]];
        if (!item || typeof item !== "object") return null;
        target = parts[2] === "b" ? [item.bullets, +parts[3]] : [item, parts[2]];
      }
    }
    const [obj, key] = target;
    if (!obj || (Array.isArray(obj) && !(key >= 0 && key < obj.length))) return null;
    return target;
  }

  // "s0.1.b.3" -> { prefix: "s0.1.b", idx: 3 } for bullet ids, otherwise null.
  function bulletParts(path) {
    const m = /^(.*\.b)\.(\d+)$/.exec(String(path || ""));
    return m ? { prefix: m[1], idx: +m[2] } : null;
  }

  // Current id of the field that holds `text`. Bullets may have moved since the review
  // (merges, deletions, reordering, undo), so they are found by their text in the same list.
  function locate(path, text) {
    const t = resolvePath(path);
    if (t && String(t[0][t[1]] ?? "") === text) return path;
    const bp = bulletParts(path);
    if (!bp) return null;
    const first = resolvePath(bp.prefix + ".0");
    if (!first) return null;
    const i = first[0].findIndex((x) => String(x ?? "") === text);
    return i >= 0 ? `${bp.prefix}.${i}` : null;
  }

  function showField(path, text) {
    if (text !== undefined) path = locate(path, text) || path;
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    const m = /^s(\d+)/.exec(path);
    if (m && cv.sections[+m[1]]) collapsed.delete(cv.sections[+m[1]]);
    renderForm(path, "end");
    const el = formEl.querySelector(`[data-path="${CSS.escape(path)}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1800);
    } else {
      toast("That field no longer exists. Run the review again.", true);
    }
  }

  // Replace one field's text (spell-check fixes and simple review fixes).
  function applyFix(issue, text) {
    const path = locate(issue.field, issue.original) || issue.field;
    const target = resolvePath(path);
    if (!target) { toast("That field no longer exists. Run the review again.", true); return false; }
    const [obj, key] = target;
    const current = obj[key] == null ? "" : String(obj[key]);
    if (current !== issue.original && current !== text &&
        !confirm("This text changed since the review. Replace it with the suggestion anyway?\n\nNow: " + current)) {
      return false;
    }
    obj[key] = text;
    changed(true);
    return true;
  }

  // Review fix that may also remove bullets (merge two bullets, or cut one). One undo step.
  function applyReviewFix(issue, text) {
    const dels = issue.delete || [];
    if (!dels.length) return applyFix(issue, text);
    const removeMain = dels.includes(issue.field);
    let main = locate(issue.field, issue.original);
    if (!main) {
      const now = resolvePath(issue.field);
      if (!now || removeMain) { toast("That bullet changed since the review. Run the review again.", true); return false; }
      if (!confirm("This text changed since the review. Apply the suggestion anyway?\n\nNow: " + now[0][now[1]])) return false;
      main = issue.field;
    }
    const toRemove = [];
    let kept = 0;
    for (const d of dels) {
      if (d === issue.field) continue;
      const p = locate(d, issue.deleteOriginals[d]);
      if (p) toRemove.push(resolvePath(p)); else kept++; // never delete a bullet whose text changed
    }
    if (removeMain) toRemove.push(resolvePath(main));
    else { const [obj, key] = resolvePath(main); obj[key] = text; }
    // Remove from the highest index down so earlier indices stay valid.
    toRemove.filter(Boolean).sort((a, b) => b[1] - a[1]).forEach(([arr, i]) => arr.splice(i, 1));
    changed(true);
    if (kept) toast(`${kept} bullet(s) to remove had changed since the review, so they were kept.`, true);
    return true;
  }

  // Applied = the CV currently reflects the fix (so Undo un-applies it).
  function reviewApplied(issue) {
    const dels = issue.delete || [];
    const gone = (p, txt) => !locate(p, txt);
    const othersGone = dels.every((d) => d === issue.field || gone(d, issue.deleteOriginals[d]));
    if (dels.includes(issue.field)) return gone(issue.field, issue.original) && othersGone;
    if (!issue.replacement) return false;
    return !!locate(issue.field, issue.replacement) && othersGone;
  }

  function renderReview(r) {
    const out = $("reviewOut");
    if (!r) { out.replaceChildren(); return; }
    const score = Number(r.score);
    const scoreCls = score <= 4 ? "lo" : score <= 7 ? "mid" : "hi";
    const nodes = [h("div", { class: "reviewTop" },
      Number.isFinite(score) ? h("div", { class: "score " + scoreCls, title: "Overall score out of 10" }, String(score), h("small", {}, "/10")) : null,
      h("p", {}, r.summary))];
    if (r.strengths.length) {
      nodes.push(h("div", { class: "reviewH" }, "What works"), h("ul", { class: "strengths" }, r.strengths.map((s) => h("li", {}, s))));
    }
    if (r.issues.length) {
      nodes.push(h("div", { class: "reviewH" }, `What to improve (${r.issues.length})`));
      for (const issue of r.issues) {
        const dels = issue.delete || [];
        const removeMain = dels.includes(issue.field);
        const others = dels.filter((d) => d !== issue.field);
        issue.applied = reviewApplied(issue);
        const card = h("div", { class: `issue ${issue.severity}${issue.applied ? " done" : ""}` });
        card.append(
          h("div", { class: "issueHead" },
            h("span", { class: "sev " + issue.severity }, issue.severity),
            h("span", { class: "issueWhere" }, issue.where),
            issue.field ? h("button", { type: "button", class: "icon", title: "Go to this field in the editor",
              onclick: () => showField(issue.field, issue.original) }, "Show") : null),
          h("p", {}, issue.problem),
          issue.suggestion ? h("p", { class: "sugg" }, "→ " + issue.suggestion) : null);

        const label = issue.applied ? "Applied ✓" : removeMain ? "Remove bullet" : others.length ? "Merge" : "Apply";
        const btn = h("button", { type: "button", class: "primary", disabled: issue.applied }, label);
        let ta = null;
        if (issue.field && issue.replacement && !removeMain) {
          ta = h("textarea", { rows: 1, value: issue.replacement, title: "Suggested text. You can edit it before applying." });
          ta.addEventListener("input", () => autoGrow(ta));
          card.append(h("div", { class: "repl" }, ta, btn));
          setTimeout(() => autoGrow(ta), 0);
        }
        if (removeMain || others.length) {
          card.append(h("div", { class: "removes" },
            h("span", { class: "hint" }, removeMain ? "Removes this bullet:" : "Also removes:"),
            ...(removeMain ? [issue.field] : others).map((d) =>
              h("div", { class: "fixText" }, h("del", {}, (removeMain ? issue.original : issue.deleteOriginals[d]) || "(empty bullet)")))));
          if (removeMain) card.append(h("div", { class: "issueBtns" }, btn));
        }
        if (ta || removeMain) {
          btn.onclick = () => {
            if (applyReviewFix(issue, ta ? ta.value.trim() : "")) {
              renderReview(lastReview);
              toast((removeMain ? "Bullet removed." : others.length ? "Bullets merged." : "Applied.") + " Undo reverts it.");
            }
          };
        }
        nodes.push(card);
      }
    }
    nodes.push(h("p", { class: "hint" }, "AI feedback can be wrong. Use your judgment, and run the review again after making changes."));
    out.replaceChildren(...nodes);
  }

  async function openReview() {
    try { $("reviewJob").value = localStorage.getItem("cv-review-job") || ""; } catch (e) { /* storage unavailable */ }
    if ($("reviewJob").value) $("reviewJobBox").open = true;
    renderReview(lastReview);
    $("reviewGo").textContent = lastReview ? "Run again" : "Run review";
    $("reviewDialog").showModal();
    try {
      const st = await aiRefreshStatus();
      if (!st.configured) {
        $("reviewOut").replaceChildren(h("div", { class: "aiStatus error" },
          "The AI can't reach Claude. Install Claude Code and sign in (run `claude` in a terminal), or add an API key in a ✨ dialog → AI settings."));
      }
    } catch (e) {
      $("reviewOut").replaceChildren(h("div", { class: "aiStatus error" }, "Could not reach the editor server: " + e.message));
    }
  }

  async function runReview() {
    const job = $("reviewJob").value;
    try { localStorage.setItem("cv-review-job", job); } catch (e) { /* storage unavailable */ }
    const go = $("reviewGo");
    go.disabled = true;
    go.textContent = "Reviewing…";
    $("reviewOut").replaceChildren(h("div", { class: "aiStatus" }, "Claude is reading your CV… this usually takes 20–60 seconds."));
    try {
      lastReview = await api("POST", "/api/ai/review", { cv, job, model: $("reviewModel").value, layout: layoutInfo, private: privacyOn() });
      renderReview(lastReview);
    } catch (e) {
      $("reviewOut").replaceChildren(h("div", { class: "aiStatus error" }, e.message));
    } finally {
      go.disabled = false;
      go.textContent = "Run again";
    }
  }

  $("review").onclick = openReview;
  $("reviewGo").onclick = runReview;
  $("reviewClose").onclick = () => $("reviewDialog").close();

  // ---------- spelling & grammar ----------
  let lastProof = null;

  // Word-level diff of two strings -> [["=" | "-" | "+", text], ...]
  function wordDiff(a, b) {
    const A = a.split(/(\s+)/), B = b.split(/(\s+)/);
    const n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    const out = [];
    const push = (t, x) => { if (out.length && out[out.length - 1][0] === t) out[out.length - 1][1] += x; else out.push([t, x]); };
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { push("=", A[i]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) push("-", A[i++]);
      else push("+", B[j++]);
    }
    while (i < n) push("-", A[i++]);
    while (j < m) push("+", B[j++]);
    return out;
  }

  function fieldValue(path) {
    const t = resolvePath(path);
    return t ? String(t[0][t[1]] ?? "") : null;
  }

  function renderProof(r) {
    const out = $("proofOut");
    $("proofAll").hidden = true;
    if (!r) { out.replaceChildren(); return; }
    if (!r.corrections.length) {
      out.replaceChildren(h("div", { class: "proofOk" }, "✓ No spelling or grammar errors found."));
      return;
    }
    let pending = 0;
    const cards = r.corrections.map((c) => {
      const applied = fieldValue(c.field) === c.replacement;
      if (!applied) pending++;
      const diff = h("div", { class: "fixText" }, wordDiff(c.original, c.replacement).map(([t, x]) =>
        t === "=" ? x : h(t === "-" ? "del" : "ins", {}, x)));
      return h("div", { class: "fix" + (applied ? " done" : "") },
        h("div", { class: "issueHead" },
          h("span", { class: "issueWhere" }, c.where),
          h("button", { type: "button", class: "icon", title: "Go to this field in the editor", onclick: () => showField(c.field, c.original) }, "Show"),
          h("button", { type: "button", class: "primary", disabled: applied, onclick: () => {
            if (applyFix(c, c.replacement)) { renderProof(lastProof); toast("Fixed. Undo reverts it."); }
          } }, applied ? "Applied ✓" : "Apply")),
        diff,
        c.explanation ? h("p", { class: "fixWhy" }, c.explanation) : null);
    });
    out.replaceChildren(h("div", { class: "reviewH" }, `${r.corrections.length} field${r.corrections.length > 1 ? "s" : ""} to fix`), ...cards);
    $("proofAll").hidden = pending < 2;
  }

  // Apply every fix whose field is unchanged since the check, as one undo step.
  function applyAllProof() {
    let done = 0, skipped = 0;
    for (const c of lastProof.corrections) {
      const t = resolvePath(c.field);
      if (!t) { skipped++; continue; }
      const cur = String(t[0][t[1]] ?? "");
      if (cur === c.replacement) continue;
      if (cur !== c.original) { skipped++; continue; }
      t[0][t[1]] = c.replacement;
      done++;
    }
    if (done) changed(true);
    renderProof(lastProof);
    toast(`Applied ${done} fix${done === 1 ? "" : "es"}` + (skipped ? `. Skipped ${skipped} field(s) you changed since the check.` : ". Undo reverts them all."));
  }

  async function runProof() {
    const go = $("proofGo");
    go.disabled = true;
    go.textContent = "Checking…";
    $("proofAll").hidden = true;
    $("proofOut").replaceChildren(h("div", { class: "aiStatus" }, "Checking your CV… this usually takes 5–15 seconds."));
    try {
      lastProof = await api("POST", "/api/ai/proofread", { cv, model: $("proofModel").value, private: privacyOn() });
      renderProof(lastProof);
    } catch (e) {
      $("proofOut").replaceChildren(h("div", { class: "aiStatus error" }, e.message));
    } finally {
      go.disabled = false;
      go.textContent = "Check again";
    }
  }

  async function openProof() {
    renderProof(lastProof);
    $("proofGo").textContent = lastProof ? "Check again" : "Check";
    $("proofDialog").showModal();
    try {
      const st = await aiRefreshStatus();
      if (!st.configured) {
        $("proofOut").replaceChildren(h("div", { class: "aiStatus error" },
          "The AI can't reach Claude. Install Claude Code and sign in (run `claude` in a terminal), or add an API key in a ✨ dialog → AI settings."));
      } else if (!lastProof) {
        runProof();
      }
    } catch (e) {
      $("proofOut").replaceChildren(h("div", { class: "aiStatus error" }, "Could not reach the editor server: " + e.message));
    }
  }

  $("proof").onclick = openProof;
  $("proofGo").onclick = runProof;
  $("proofAll").onclick = applyAllProof;
  $("proofClose").onclick = () => $("proofDialog").close();

  // ---------- light / dark mode (editor UI only) ----------
  function currentTheme() { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; }

  function applyTheme(theme, remember) {
    document.documentElement.dataset.theme = theme;
    $("theme").textContent = theme === "dark" ? "☀" : "☾";
    $("theme").title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    if (remember) { try { localStorage.setItem("cv-editor-theme", theme); } catch (e) { /* storage unavailable */ } }
    if (frame.contentWindow) frame.contentWindow.postMessage({ type: "ui-theme", theme }, "*");
  }

  $("theme").onclick = () => applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
  // Until the user picks a theme, follow the system setting live.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    let saved = null;
    try { saved = localStorage.getItem("cv-editor-theme"); } catch (err) { /* storage unavailable */ }
    if (!saved) applyTheme(e.matches ? "dark" : "light", false);
  });
  applyTheme(currentTheme(), false);

  // ---------- privacy: hide personal details from the AI (on by default) ----------
  function privacyOn() {
    try { return localStorage.getItem("cv-ai-private") !== "off"; } catch (e) { return true; }
  }
  const privacyBoxes = document.querySelectorAll("input.privacy");
  privacyBoxes.forEach((cb) => {
    cb.checked = privacyOn();
    cb.addEventListener("change", () => {
      try { localStorage.setItem("cv-ai-private", cb.checked ? "on" : "off"); } catch (e) { /* storage unavailable */ }
      privacyBoxes.forEach((other) => { other.checked = cb.checked; });
    });
  });

  // ---------- wiring ----------
  $("undo").onclick = undo;
  $("redo").onclick = redo;
  $("save").onclick = save;
  $("export").onclick = exportPdf;
  $("history").onclick = showHistory;
  $("zoomIn").onclick = () => zoomBy(1.1);
  $("zoomOut").onclick = () => zoomBy(1 / 1.1);
  $("zoomFit").onclick = () => { zoom = "fit"; applyZoom(); };
  window.addEventListener("resize", () => { if (zoom === "fit") applyZoom(); });
  new ResizeObserver(() => { if (zoom === "fit") applyZoom(); }).observe(frameWrap);

  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    const inText = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== "range";
    if (k === "s") { e.preventDefault(); save(); }
    else if (k === "e") { e.preventDefault(); exportPdf(); }
    else if (!inText && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (!inText && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  });

  window.addEventListener("beforeunload", (e) => {
    if (cv && isDirty()) { e.preventDefault(); e.returnValue = ""; }
  });

  try {
    const z = localStorage.getItem("cv-editor-zoom");
    if (z && z !== "fit" && !isNaN(parseFloat(z))) zoom = parseFloat(z);
  } catch (e) { /* storage unavailable */ }
  applyZoom();

  api("GET", "/api/cv").then((data) => {
    cv = normalize(data);
    savedJSON = lastSnap = JSON.stringify(cv);
    renderForm(null);
    afterChange();
  }).catch((e) => {
    $("status").textContent = "Could not load data/cv.json: " + e.message;
  });
})();
