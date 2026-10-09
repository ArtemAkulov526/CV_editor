// Turns CV data (data/cv.json) into HTML. Used by both the live preview and the PDF export,
// so what you see in the editor is exactly what ends up in the PDF.
(function (global) {
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function safeUrl(url) {
    url = url.trim();
    if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) return "mailto:" + url;
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(url)) return "https://" + url;
    return "";
  }

  // Inline formatting: **bold**, *italic*, [text](url)
  function fmt(s) {
    let out = esc(s);
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const href = safeUrl(url.replace(/&amp;/g, "&"));
      return href ? `<a href="${esc(href)}">${text}</a>` : text;
    });
    out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    out = out.replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<i>$2</i>");
    return keepHyphens(out);
  }

  // Small caps built from real capitals (the font's own small-caps glyphs live in a private Unicode
  // area, which would make the PDF text unreadable for copy-paste and ATS parsers).
  function smallCaps(s) {
    return esc(s).replace(/(&\w+;)|([^\s&A-ZА-ЯЇІЄҐ0-9]+)/g, (m, entity, lower) =>
      entity ? entity : `<span class="sc">${lower.toUpperCase()}</span>`);
  }

  // Keep hyphenated words (e.g. "user-selected") together, like LaTeX does, instead of breaking after "-".
  function keepHyphens(html) {
    return html.split(/(<[^>]*>)/).map((part) =>
      part.startsWith("<") ? part : part.replace(/[^\s<>]+-[^\s<>]+/g, (w) => `<span class="nobr">${w}</span>`)
    ).join("");
  }

  // Contacts: plain emails become clickable without changing how they look.
  function contact(s) {
    const t = String(s || "").trim();
    if (/^[^\s@\[\]]+@[^\s@]+\.[^\s@]+$/.test(t)) return `<a href="mailto:${esc(t)}">${esc(t)}</a>`;
    return fmt(t);
  }

  function lines(text) {
    return String(text || "").split(/\n/).map(fmt).join("<br>");
  }

  function bullets(list) {
    const items = (list || []).filter((b) => String(b).trim());
    if (!items.length) return "";
    return `<ul class="bullets">${items.map((b) => `<li>${lines(b)}</li>`).join("")}</ul>`;
  }

  function rowLR(left, right, cls) {
    if (!left && !right) return "";
    return `<div class="row ${cls}"><span class="l">${left}</span>${right ? `<span class="r">${right}</span>` : ""}</div>`;
  }

  const renderers = {
    entries(sec) {
      return (sec.items || []).map((it) => {
        const subCls = sec.italicSubtitle ? "sub italic" : "sub";
        return `<div class="entry">
          ${rowLR(it.title ? `<b>${fmt(it.title)}</b>` : "", fmt(it.titleRight), "title")}
          ${rowLR(fmt(it.subtitle), fmt(it.subtitleRight), subCls)}
          ${bullets(it.bullets)}
        </div>`;
      }).join("");
    },
    skills(sec) {
      const rows = (sec.items || []).map((it) =>
        `<tr><td class="k">${fmt(it.label)}</td><td class="v">${lines(it.value)}</td></tr>`).join("");
      return `<table class="skills"><tbody>${rows}</tbody></table>`;
    },
    projects(sec) {
      return (sec.items || []).map((it) => {
        let name = fmt(it.name);
        const href = it.link ? safeUrl(it.link) : "";
        if (href) name = `<a href="${esc(href)}">${name}</a>`;
        return `<div class="entry project">
          <div class="phead"><b>${name}</b>${it.tech ? ` <span class="tech">${fmt(it.tech)}</span>` : ""}</div>
          ${it.description ? `<div class="desc">${lines(it.description)}</div>` : ""}
          ${bullets(it.bullets)}
        </div>`;
      }).join("");
    },
    text(sec) {
      return `<div class="entry text">${String(sec.text || "").split(/\n\s*\n/).map((p) => `<p>${lines(p)}</p>`).join("")}</div>`;
    },
    list(sec) {
      return `<div class="entry">${bullets(sec.items)}</div>`;
    },
  };

  function renderCV(cv) {
    cv = cv || {};
    const style = cv.style || {};
    const contacts = (cv.contacts || []).filter((c) => String(c).trim()).map(contact)
      .join(' <span class="sep">·</span> ');
    const headline = String(cv.headline || "").trim() ? `<div class="headline">${fmt(cv.headline.trim())}</div>` : "";
    const sections = (cv.sections || []).filter((s) => !s.hidden).map((sec) => {
      const body = (renderers[sec.type] || renderers.text)(sec);
      return `<section class="sec sec-${esc(sec.type)}"><h2>${smallCaps(sec.title)}</h2>${body}</section>`;
    }).join("");
    return {
      vars: {
        "--fs": (Number(style.fontSize) || 9.96) + "pt",
        "--gap": (style.spacing == null ? 1 : Number(style.spacing)),
      },
      html: `<header><h1>${smallCaps(cv.name)}</h1>${headline}<div class="contacts">${contacts}</div></header>${sections}`,
    };
  }

  global.renderCV = renderCV;
})(window);
