"""CV editor — local server.

Run:  python server.py        (then open http://127.0.0.1:8765)

Your CV content lives in data/cv.json (created from data/cv.example.json on first run). Every save keeps the previous version in backups/.
"Export PDF" renders static/cv.html with headless Chromium (Playwright) into output/<fileName>.pdf.
"""
import json
import os
import re
import shutil
import sys
import threading
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

import ai

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data" / "cv.json"
EXAMPLE = ROOT / "data" / "cv.example.json"
BACKUPS = ROOT / "backups"
OUTPUT = ROOT / "output"
HOST, PORT = "127.0.0.1", int(os.environ.get("CV_PORT", "8765"))
MAX_BACKUPS = 50
MAX_BODY = 5 * 1024 * 1024  # a CV is a few KB; anything this big is not a real request

_export_lock = threading.Lock()
_save_lock = threading.Lock()  # Save and Export can arrive at the same moment


def load_cv() -> dict:
    if not DATA.exists():  # first run after cloning: start from the example CV
        shutil.copyfile(EXAMPLE, DATA)
    try:
        return json.loads(DATA.read_text(encoding="utf-8"))
    except ValueError as e:
        raise ValueError(f"data/cv.json is not valid JSON ({e}). Fix it, or copy a version from backups/.")


def save_cv(cv: dict) -> None:
    if not isinstance(cv, dict) or not isinstance(cv.get("sections"), list):
        raise ValueError("CV must be an object with a 'sections' list")
    new_text = json.dumps(cv, ensure_ascii=False, indent=2) + "\n"
    with _save_lock:
        if DATA.exists():
            if DATA.read_text(encoding="utf-8") == new_text:
                return
            BACKUPS.mkdir(exist_ok=True)
            backup = BACKUPS / f"cv-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
            if not backup.exists():  # two saves in one second: keep the older version, not the newer one
                shutil.copy2(DATA, backup)
            for old in sorted(BACKUPS.glob("cv-*.json"))[:-MAX_BACKUPS]:
                old.unlink()
        tmp = DATA.with_suffix(".tmp")
        tmp.write_text(new_text, encoding="utf-8")
        os.replace(tmp, DATA)


# Windows can't use these as file names, with or without an extension ("CON.pdf" is the console).
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def safe_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name or "").strip().strip(".")[:120].strip()
    if name.split(".")[0].upper() in WINDOWS_RESERVED:
        name = "CV_" + name
    return name or "CV"


def export_pdf(cv: dict) -> Path:
    from playwright.sync_api import sync_playwright

    OUTPUT.mkdir(exist_ok=True)
    target = OUTPUT / f"{safe_filename(cv.get('fileName') or cv.get('name'))}.pdf"
    with _export_lock, sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            page.goto(f"http://{HOST}:{PORT}/static/cv.html", wait_until="networkidle")
            page.wait_for_function("window.__cvReady === true", timeout=15000)
            page.emulate_media(media="print")
            pdf = page.pdf(prefer_css_page_size=True, print_background=True)
        finally:
            browser.close()
    tmp = target.with_suffix(".tmp")
    tmp.write_bytes(pdf)
    try:
        os.replace(tmp, target)
    except PermissionError:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"{target.name} is open in another program (close it and try again)")
    return target


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/" in self.path:
            sys.stderr.write("%s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # Other websites may not embed the editor in a frame (clickjacking); only the editor
        # itself may frame its own preview.
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Content-Security-Policy", "frame-ancestors 'self'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def list_directory(self, path):  # no folder listings
        self._json(404, {"error": "not found"})
        return None

    def _servable(self) -> bool:
        """Only files inside static/ and output/ may be served. Checked on the real file path,
        so tricks like /static/../data/cv.json or /static/%2e%2e/ can't reach other files."""
        try:
            real = Path(self.translate_path(self.path)).resolve()
        except (OSError, ValueError):
            return False
        return any(real == base or base in real.parents for base in (STATIC.resolve(), OUTPUT.resolve()))

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _allowed(self) -> bool:
        """Only answer the editor itself: blocks other websites (and DNS-rebinding tricks) from
        reading or changing the CV, or spending AI credits, through this local server."""
        local = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
        if self.headers.get("Host", "") not in local:
            self._json(403, {"error": "forbidden host"})
            return False
        origin = self.headers.get("Origin")
        if self.command != "GET" and origin is not None and origin.split("://", 1)[-1] not in local:
            self._json(403, {"error": "forbidden origin"})
            return False
        return True

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("Bad Content-Length")
        if length < 0 or length > MAX_BODY:
            raise ValueError("Request body is too large")
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else None

    def do_GET(self):
        if not self._allowed():
            return
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self.path = "/static/editor.html"
        elif path == "/api/cv":
            try:
                return self._json(200, load_cv())
            except (OSError, ValueError) as e:
                return self._json(500, {"error": str(e)})
        elif path == "/api/ai/status":
            return self._json(200, ai.status())
        elif path.startswith("/api/backups"):
            names = sorted((p.name for p in BACKUPS.glob("cv-*.json")), reverse=True) if BACKUPS.exists() else []
            return self._json(200, names)
        elif path.startswith("/api/backup/"):
            name = Path(path.rsplit("/", 1)[1]).name
            f = BACKUPS / name
            if not re.fullmatch(r"cv-\d{8}-\d{6}\.json", name) or not f.exists():
                return self._json(404, {"error": "not found"})
            return self._json(200, json.loads(f.read_text(encoding="utf-8")))
        if not self._servable():
            return self._json(404, {"error": "not found"})
        return super().do_GET()

    def do_PUT(self):
        if not self._allowed():
            return
        if self.path != "/api/cv":
            return self._json(404, {"error": "not found"})
        try:
            save_cv(self._read_json())
        except (ValueError, json.JSONDecodeError) as e:
            return self._json(400, {"error": str(e)})
        return self._json(200, {"ok": True})

    def do_POST(self):
        if not self._allowed():
            return
        routes = {
            "/api/ai/key": lambda body: (ai.save_key(body.get("key", "")), ai.status())[1],
            "/api/ai/proofread": ai.proofread,
            "/api/ai/review": ai.review,
            "/api/ai": lambda body: {"suggestions": ai.suggest(body)},
            "/api/export": self._export,
        }
        handler = routes.get(self.path)
        if handler is None:
            return self._json(404, {"error": "not found"})
        try:
            body = self._read_json()
        except ValueError as e:  # bad JSON, bad length or too large
            return self._json(400, {"error": f"Bad request: {e}"})
        if body is not None and not isinstance(body, dict):
            return self._json(400, {"error": "Bad request: expected a JSON object"})
        try:
            return self._json(200, handler(body or {}) if self.path != "/api/export" else handler(body))
        except ai.AIError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:  # unexpected failure: still report it to the editor
            return self._json(500, {"error": f"Request failed: {e}"})

    def _export(self, cv):
        if cv is not None:
            save_cv(cv)
        target = export_pdf(load_cv())
        return {"ok": True, "path": str(target), "url": f"/output/{quote(target.name)}"}

def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"CV editor running at {url}  (Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
