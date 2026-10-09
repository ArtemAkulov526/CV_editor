"""AI writing help and CV review for the CV editor.

Two ways to reach Claude, tried in this order:
1. An Anthropic API key, if you set one: the ANTHROPIC_API_KEY environment variable, or the key file
   ~/.cv_editor/anthropic_key that the editor writes when you paste a key in (kept outside the
   project folder so it never gets synced or shared along with the CV).
2. Otherwise, the Claude Code CLI (`claude -p`), which uses your Claude subscription login,
   so no API key is needed.
"""
import json
import os
import shutil
import subprocess
from datetime import date
from pathlib import Path

KEY_FILE = Path.home() / ".cv_editor" / "anthropic_key"
CLAUDE_CODE_TIMEOUT = 300  # seconds

MODELS = {
    "claude-haiku-5-5": "Haiku 5.5",
    "claude-sonnet-5-5": "Sonnet 5.5",
    "claude-opus-5-5": "Opus 5.5",
}
# Short rewrites are easy: the small model writes them well and uses far less of your plan.
# Reviewing a whole CV takes judgment, so it defaults to the mid-size model.
DEFAULT_MODELS = {"write": "claude-haiku-5-5", "review": "claude-sonnet-5-5", "proofread": "claude-haiku-5-5"}
EFFORT = {"write": "low", "review": "medium", "proofread": "medium"}

STYLE_RULES = """- Use only facts the user gave you (in the notes or the CV). Never invent employers, tools, \
numbers, percentages, team sizes or results. If a metric would help but none was given, leave it out.
- Bullet points start with a strong action verb, have no "I", and fit in one or two lines \
(roughly 90-200 characters). Use past tense, or present tense for a current role.
- Match the tone, tense and punctuation of the CV's existing bullet points (for example whether \
they end with a period).
- Prefer concrete technologies and outcomes over generic claims such as "hard-working" or \
"team player".
- Plain text only. Do not use markdown, bullet symbols or numbering."""

WRITE_SYSTEM = """You help a job seeker write their CV. The CV is in English unless its existing content \
is clearly in another language; write in the CV's language even when the user's notes are in \
another language (for example Ukrainian or Russian).

Rules for everything you write:
""" + STYLE_RULES

REVIEW_SYSTEM = """You are an experienced tech recruiter and hiring manager reviewing a software \
engineer's CV. Give honest, specific, actionable feedback that would most improve the person's \
chances of getting interviews.

Look at:
- Content: impact and specificity of bullet points, vague or weak wording, missing information \
(for example a job with no bullet points, especially the current one).
- Relevance: fit for the target position or job posting if one is given, and keywords that \
applicant tracking systems would look for.
- Consistency: date formats, punctuation, tense (present for the current role, past otherwise), \
capitalisation, naming of technologies.
- Language: grammar, spelling, unnatural phrasing (the author is not a native English speaker).
- Structure: section order, what to emphasise or cut, and use of space on the page.

How to report issues:
- Report at most 12 issues, the most important first. Skip trivia.
- Each issue refers to one field by its id from the <fields> list, or field "" when it concerns \
the CV as a whole or something missing.
- "replacement" is the complete new text for that field, ready to paste in. Give one only when \
you can write it from facts already in the CV. Otherwise leave it "" and say in "suggestion" \
what information the person should add.
- Replacement text follows these rules:
""" + STYLE_RULES + """
- Write the feedback in English, plainly and directly. The score is 1-10, where 10 means ready \
to send for the target role."""

TASKS = {
    "bullets": "Write {count} distinct bullet points for the entry below, based on the user's notes. "
               "Cover different aspects of the work rather than rephrasing one point.",
    "improve": "Rewrite the bullet point below in {count} different ways. Keep the meaning and facts; "
               "make it clearer, more specific and more impactful.",
    "headline": "Suggest {count} short professional headlines (2-8 words, e.g. 'Python Backend Developer') "
                "to place under the person's name, matching the CV and the target position if given. "
                "No punctuation at the end.",
}

SUGGEST_SCHEMA = {
    "type": "object",
    "properties": {"suggestions": {"type": "array", "items": {"type": "string"}}},
    "required": ["suggestions"],
    "additionalProperties": False,
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "score": {"type": "integer"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "severity": {"type": "string", "enum": ["high", "medium", "low"]},
                    "field": {"type": "string"},
                    "where": {"type": "string"},
                    "problem": {"type": "string"},
                    "suggestion": {"type": "string"},
                    "replacement": {"type": "string"},
                },
                "required": ["severity", "field", "where", "problem", "suggestion", "replacement"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "score", "strengths", "issues"],
    "additionalProperties": False,
}


PROOFREAD_SYSTEM = """You are a careful proofreader of a CV written by a non-native English speaker \
(or in the CV's own language, if it is not English).

Find only real errors:
- spelling mistakes and typos
- grammar errors (articles, verb forms, prepositions, agreement)
- wrong capitalisation or spelling of technology and product names (for example "Postgresql" -> \
"PostgreSQL", "Javascript" -> "JavaScript", "fast api" -> "FastAPI", "Github" -> "GitHub")
- obvious punctuation errors, such as double spaces, a missing space after a comma, or unbalanced brackets

Do not change style, wording, tone or content, do not shorten text, and do not "improve" correct \
sentences. Leave correct technical terms, names, URLs and email addresses alone. British and \
American spelling are both fine. Make the smallest edit that fixes each error.

For every field that has at least one error, return one correction: the field id from the \
<fields> list, the full corrected text of that field, and a short explanation of what was \
wrong. Return an empty list when there is nothing to fix."""

PROOFREAD_SCHEMA = {
    "type": "object",
    "properties": {
        "corrections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "field": {"type": "string"},
                    "corrected": {"type": "string"},
                    "explanation": {"type": "string"},
                },
                "required": ["field", "corrected", "explanation"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["corrections"],
    "additionalProperties": False,
}


class AIError(Exception):
    pass


# ---------- configuration ----------

def get_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key and KEY_FILE.exists():
        key = KEY_FILE.read_text(encoding="utf-8").strip()
    return key


def find_claude_code():
    found = shutil.which("claude")
    if found:
        return found
    for name in ("claude.exe", "claude"):
        candidate = Path.home() / ".local" / "bin" / name
        if candidate.exists():
            return str(candidate)
    return None


def _has_sdk() -> bool:
    try:
        import anthropic  # noqa: F401
        return True
    except ImportError:
        return False


def status() -> dict:
    """Which backend will be used: "api" (key set), "claude-code" (CLI found) or None."""
    key_source = "env" if os.environ.get("ANTHROPIC_API_KEY", "").strip() else ("file" if get_key() else None)
    if key_source and _has_sdk():
        backend = "api"
    elif find_claude_code():
        backend = "claude-code"
    else:
        backend = None
    return {"configured": backend is not None, "backend": backend, "keySource": key_source,
            "models": MODELS, "defaults": DEFAULT_MODELS}


def save_key(key: str) -> None:
    key = (key or "").strip()
    if not key:
        if KEY_FILE.exists():
            KEY_FILE.unlink()
        return
    if not key.startswith("sk-ant-"):
        raise AIError("That doesn't look like an Anthropic API key (they start with 'sk-ant-').")
    KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    KEY_FILE.write_text(key, encoding="utf-8")


def _pick_model(req: dict, kind: str) -> str:
    model = req.get("model") or DEFAULT_MODELS[kind]
    if model not in MODELS:
        raise AIError(f"Unknown model: {model!r}")
    return model


# ---------- writing suggestions ----------

def _cv_as_text(cv: dict) -> str:
    """Compact JSON of the CV content, without editor-only settings."""
    data = {k: v for k, v in cv.items() if k not in ("style", "fileName")}
    return json.dumps(data, ensure_ascii=False, indent=1)


def build_prompt(req: dict) -> str:
    mode = req.get("mode")
    if mode not in TASKS:
        raise AIError(f"Unknown AI mode: {mode!r}")
    count = max(1, min(int(req.get("count") or (4 if mode == "bullets" else 3)), 8))
    cv = req.get("cv") or {}

    parts = [f"<cv>\n{_cv_as_text(cv)}\n</cv>"]
    if cv.get("headline"):
        parts.append(f"<target_position>{cv['headline']}</target_position>")
    if req.get("entry"):
        parts.append(f"<entry>\n{json.dumps(req['entry'], ensure_ascii=False, indent=1)}\n</entry>")
    if req.get("text"):
        tag = "bullet_to_improve" if mode == "improve" else "user_notes"
        parts.append(f"<{tag}>\n{req['text']}\n</{tag}>")
    if req.get("instructions"):
        parts.append(f"<extra_instructions>\n{req['instructions']}\n</extra_instructions>")
    parts.append(TASKS[mode].format(count=count))
    if mode == "bullets" and not (req.get("text") or "").strip():
        parts.append("The user gave no notes: base the bullets only on what the entry and the rest of the "
                     "CV already say, and keep them modest.")
    return "\n\n".join(parts)


def suggest(req: dict) -> list:
    data = _run(build_prompt(req), WRITE_SYSTEM, SUGGEST_SCHEMA, _pick_model(req, "write"), EFFORT["write"])
    try:
        suggestions = data["suggestions"]
    except (KeyError, TypeError):
        raise AIError("Got an unexpected answer from the model. Please try again.")
    return [s.strip().lstrip("•-* ").strip() for s in suggestions if isinstance(s, str) and s.strip()]


# ---------- review ----------

def cv_fields(cv: dict) -> dict:
    """Every editable text in the CV as {path: (label, text)}. Paths match the editor's field ids."""
    fields = {"name": ("Name", cv.get("name", "")), "headline": ("Headline under the name", cv.get("headline", ""))}
    for i, c in enumerate(cv.get("contacts") or []):
        fields[f"contacts.{i}"] = (f"Contact {i + 1}", c)
    keys = {
        "entries": [("title", "organization"), ("titleRight", "location"), ("subtitle", "role"), ("subtitleRight", "dates")],
        "projects": [("name", "name"), ("tech", "technologies"), ("link", "link"), ("description", "description")],
        "skills": [("label", "category"), ("value", "skills")],
    }
    for si, sec in enumerate(cv.get("sections") or []):
        if sec.get("hidden"):
            continue
        st, title = sec.get("type"), sec.get("title") or f"Section {si + 1}"
        fields[f"s{si}.title"] = (f"Section title: {title}", title)
        if st == "text":
            fields[f"s{si}.text"] = (title, sec.get("text", ""))
            continue
        if st == "list":
            for bi, b in enumerate(sec.get("items") or []):
                fields[f"s{si}.b.{bi}"] = (f"{title} > bullet {bi + 1}", b)
            continue
        for ii, it in enumerate(sec.get("items") or []):
            if not isinstance(it, dict):
                continue
            name = it.get("title") or it.get("name") or it.get("label") or f"item {ii + 1}"
            for key, what in keys.get(st, []):
                fields[f"s{si}.{ii}.{key}"] = (f"{title} > {name} > {what}", it.get(key, ""))
            for bi, b in enumerate(it.get("bullets") or []):
                fields[f"s{si}.{ii}.b.{bi}"] = (f"{title} > {name} > bullet {bi + 1}", b)
    return fields


def review(req: dict) -> dict:
    cv = req.get("cv") or {}
    fields = cv_fields(cv)
    lines = [f"[{path}] {label}: {json.dumps(text, ensure_ascii=False)}" for path, (label, text) in fields.items()]
    parts = [f"<fields>\n" + "\n".join(lines) + "\n</fields>",
             f"<today>{date.today().isoformat()}</today>"]
    layout = req.get("layout") or {}
    if layout.get("pages"):
        free = layout.get("freeFrac")
        parts.append(f"<layout>One A4 page template. The CV currently fills {layout['pages']} page(s)"
                     + (f", with about {round(free * 100)}% of the last page empty" if isinstance(free, (int, float)) else "")
                     + ". Empty fields are not printed.</layout>")
    if (req.get("job") or "").strip():
        parts.append(f"<target_job_posting>\n{req['job'].strip()}\n</target_job_posting>")
    parts.append("Review this CV" + (" for the job posting above." if (req.get("job") or "").strip() else "."))

    data = _run("\n\n".join(parts), REVIEW_SYSTEM, REVIEW_SCHEMA, _pick_model(req, "review"), EFFORT["review"])
    if not isinstance(data, dict) or not isinstance(data.get("issues"), list):
        raise AIError("Got an unexpected answer from the model. Please try again.")
    order = {"high": 0, "medium": 1, "low": 2}
    issues = []
    for it in data["issues"]:
        if not isinstance(it, dict):
            continue
        path = it.get("field") or ""
        if path not in fields:
            path = ""
        issues.append({
            "severity": it.get("severity") if it.get("severity") in order else "low",
            "field": path,
            "where": it.get("where") or (fields[path][0] if path else "Whole CV"),
            "problem": it.get("problem", ""),
            "suggestion": it.get("suggestion", ""),
            "replacement": (it.get("replacement") or "").strip() if path else "",
            "original": fields[path][1] if path else "",
        })
    issues.sort(key=lambda x: order[x["severity"]])
    return {"summary": data.get("summary", ""), "score": data.get("score"),
            "strengths": [s for s in data.get("strengths") or [] if isinstance(s, str)], "issues": issues}


# ---------- proofreading ----------

def proofread(req: dict) -> dict:
    fields = {path: (label, text) for path, (label, text) in cv_fields(req.get("cv") or {}).items()
              if isinstance(text, str) and text.strip() and not path.endswith(".link")}
    if not fields:
        return {"corrections": []}
    lines = [f"[{path}] {label}: {json.dumps(text, ensure_ascii=False)}" for path, (label, text) in fields.items()]
    prompt = "<fields>\n" + "\n".join(lines) + "\n</fields>\n\nProofread every field above."
    data = _run(prompt, PROOFREAD_SYSTEM, PROOFREAD_SCHEMA, _pick_model(req, "proofread"), EFFORT["proofread"])
    if not isinstance(data, dict) or not isinstance(data.get("corrections"), list):
        raise AIError("Got an unexpected answer from the model. Please try again.")
    out, seen = [], set()
    for c in data["corrections"]:
        if not isinstance(c, dict):
            continue
        path, fixed = c.get("field"), (c.get("corrected") or "").strip()
        if path not in fields or path in seen or not fixed or fixed == fields[path][1].strip():
            continue  # unknown field, duplicate, or no actual change
        seen.add(path)
        out.append({"field": path, "where": fields[path][0], "original": fields[path][1],
                    "replacement": fixed, "explanation": c.get("explanation", "")})
    order = list(fields)
    out.sort(key=lambda x: order.index(x["field"]))
    return {"corrections": out}


# ---------- backends ----------

def _run(prompt: str, system: str, schema: dict, model: str, effort: str) -> dict:
    backend = status()["backend"]
    if backend == "api":
        return _via_api(prompt, system, schema, model, effort)
    if backend == "claude-code":
        return _via_claude_code(prompt, system, schema, model, effort)
    raise AIError("No way to reach Claude: install Claude Code and log in, or add an Anthropic API key.")


def _via_claude_code(prompt: str, system: str, schema: dict, model: str, effort: str) -> dict:
    """Run Claude Code headless with no tools and no saved session; uses the user's Claude login."""
    cmd = [
        find_claude_code(), "-p",
        "--output-format", "json",
        "--json-schema", json.dumps(schema),
        "--system-prompt", system,
        "--model", model,
        "--effort", effort,
        "--tools", "",
        "--strict-mcp-config",
        "--no-session-persistence",
    ]
    try:
        proc = subprocess.run(
            cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=CLAUDE_CODE_TIMEOUT, cwd=str(Path.home()),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        raise AIError("Claude Code took too long to answer. Try again.")
    except OSError as e:
        raise AIError(f"Could not start Claude Code: {e}")

    try:
        out = json.loads(proc.stdout)
    except ValueError:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        raise AIError("Claude Code failed: " + (detail[-1] if detail else f"exit code {proc.returncode}"))
    if out.get("is_error") or out.get("subtype") != "success":
        msg = str(out.get("result") or out.get("subtype") or "unknown error")
        if "login" in msg.lower() or "auth" in msg.lower():
            msg += " (open a terminal, run `claude`, and log in)"
        raise AIError("Claude Code: " + msg)
    data = out.get("structured_output")
    if data is None:
        try:
            data = json.loads(out.get("result") or "")
        except ValueError:
            raise AIError("Got an unexpected answer from Claude Code. Please try again.")
    return data


def _via_api(prompt: str, system: str, schema: dict, model: str, effort: str) -> dict:
    import anthropic

    client = anthropic.Anthropic(api_key=get_key())
    extra = {}
    if model in ("claude-opus-5-5", "claude-sonnet-5-5"):
        # If a safety classifier declines the request, retry it on Anthropic's recommended fallback model.
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    try:
        response = client.beta.messages.create(
            model=model,
            max_tokens=16000,
            system=system,
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            **extra,
        )
    except anthropic.AuthenticationError:
        raise AIError("The API key was rejected. Check it in AI settings, or remove it to use Claude Code.")
    except anthropic.PermissionDeniedError:
        raise AIError("This API key doesn't have access to the model.")
    except anthropic.RateLimitError:
        raise AIError("Rate limited by the API. Wait a moment and try again.")
    except anthropic.APIStatusError as e:
        msg = getattr(e, "message", str(e))
        if "credit" in msg.lower() or "billing" in msg.lower():
            raise AIError("Your Anthropic account has no API credits. Add credits at console.anthropic.com.")
        raise AIError(f"API error ({e.status_code}): {msg}")
    except anthropic.APIConnectionError:
        raise AIError("Could not reach the Claude API. Check your internet connection.")

    if response.stop_reason == "refusal":
        raise AIError("The model declined this request. Try rephrasing.")
    if response.stop_reason == "max_tokens":
        raise AIError("The answer was cut off. Please try again.")
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except ValueError:
        raise AIError("Got an unexpected answer from the model. Please try again.")
