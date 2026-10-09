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

_export_lock = threading.Lock()


def load_cv() -> dict:
    if not DATA.exists():  # first run after cloning: start from the example CV
        shutil.copyfile(EXAMPLE, DATA)
    return json.loads(DATA.read_text(encoding="utf-8"))


def save_cv(cv: dict) -> None:
    if not isinstance(cv, dict) or not isinstance(cv.get("sections"), list):
        raise ValueError("CV must be an object with a 'sections' list")
    new_text = json.dumps(cv, ensure_ascii=False, indent=2) + "\n"
    if DATA.exists():
        if DATA.read_text(encoding="utf-8") == new_text:
            return
        BACKUPS.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(DATA, BACKUPS / f"cv-{stamp}.json")
        for old in sorted(BACKUPS.glob("cv-*.json"))[:-MAX_BACKUPS]:
            old.unlink()
    tmp = DATA.with_suffix(".tmp")
    tmp.write_text(new_text, encoding="utf-8")
    os.replace(tmp, DATA)


def safe_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name or "").strip().strip(".")
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
        super().end_headers()

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
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else None

    def do_GET(self):
        if not self._allowed():
            return
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self.path = "/static/editor.html"
        elif path == "/api/cv":
            return self._json(200, load_cv())
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
        elif path.startswith("/output/"):
            pass
        elif not path.startswith("/static/"):
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
        if self.path == "/api/ai/key":
            try:
                ai.save_key((self._read_json() or {}).get("key", ""))
            except ai.AIError as e:
                return self._json(400, {"error": str(e)})
            return self._json(200, ai.status())
        if self.path == "/api/ai/proofread":
            try:
                return self._json(200, ai.proofread(self._read_json() or {}))
            except ai.AIError as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:  # unexpected failure: still report it to the editor
                return self._json(500, {"error": f"Spell check failed: {e}"})
        if self.path == "/api/ai/review":
            try:
                return self._json(200, ai.review(self._read_json() or {}))
            except ai.AIError as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:  # unexpected failure: still report it to the editor
                return self._json(500, {"error": f"Review failed: {e}"})
        if self.path == "/api/ai":
            try:
                return self._json(200, {"suggestions": ai.suggest(self._read_json() or {})})
            except ai.AIError as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:  # unexpected failure: still report it to the editor
                return self._json(500, {"error": f"AI request failed: {e}"})
        if self.path != "/api/export":
            return self._json(404, {"error": "not found"})
        try:
            cv = self._read_json()
            if cv is not None:
                save_cv(cv)
            target = export_pdf(load_cv())
        except Exception as e:  # report any failure back to the editor
            return self._json(500, {"error": str(e)})
        return self._json(200, {"ok": True, "path": str(target), "url": f"/output/{quote(target.name)}"})


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
