"""本機開發用的假 Apps Script。

    python dev/mock_api.py            # 預設 8000 埠
    python dev/mock_api.py 8080

然後開 http://localhost:8000/#k=test&api=http://localhost:8000/api
規則跟 apps-script/Code.gs 一樣：lit 看這分鐘有沒有點亮過、cheat 看當天有沒有紀錄。
照片會寫進 dev/_data/photos 與 dev/_data/thumbs，紀錄在 dev/_data/rows.json。
"""
import base64
import json
import os
import re
import sys
import threading
from urllib.parse import parse_qs, urlparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "dev", "_data")
PHOTOS = os.path.join(DATA, "photos")
THUMBS = os.path.join(DATA, "thumbs")
ROWS = os.path.join(DATA, "rows.json")
KEY = os.environ.get("MOCK_KEY", "test")
LOCK = threading.Lock()

for d in (PHOTOS, THUMBS):
    os.makedirs(d, exist_ok=True)


def load_rows():
    if not os.path.exists(ROWS):
        return []
    with open(ROWS, encoding="utf-8") as f:
        return json.load(f)


def save_rows(rows):
    with open(ROWS, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)


def strip_b64(s):
    s = str(s)
    if s.startswith("data:") and "," in s:
        s = s.split(",", 1)[1]
    return base64.b64decode(s)


def upload(req):
    date = str(req.get("date", ""))
    minute = str(req.get("minute", ""))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        return {"ok": False, "error": "bad_date"}
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", minute):
        return {"ok": False, "error": "bad_minute"}
    if not req.get("photo"):
        return {"ok": False, "error": "no_photo"}
    taken_at = str(req.get("taken_at") or f"{date}T{minute}:00")
    uid = str(req.get("uid", ""))[:64]
    with LOCK:
        rows = load_rows()
        if uid:
            for r in rows:
                if len(r) > 9 and r[9] == uid:
                    return {"ok": True, "lit": bool(r[5]), "cheat": bool(r[6]), "row": r, "duplicate": True}
        lit = not any(r[1] == minute and r[5] for r in rows)
        today_has = any(r[0] == date for r in rows)
        cheat = today_has or req.get("cheat") is True or str(req.get("cheat")).lower() == "true"
        base = f"{date}_{minute.replace(':', '')}" + ("_cheat" if cheat else "")
        name, n = base + ".jpg", 2
        while os.path.exists(os.path.join(PHOTOS, name)):
            name = f"{base}_{n}.jpg"
            n += 1
        with open(os.path.join(PHOTOS, name), "wb") as f:
            f.write(strip_b64(req["photo"]))
        thumb_id = ""
        if req.get("thumb"):
            with open(os.path.join(THUMBS, name), "wb") as f:
                f.write(strip_b64(req["thumb"]))
            thumb_id = "t_" + name
        row = [date, minute, taken_at, "f_" + name, thumb_id, 1 if lit else 0, 1 if cheat else 0, str(req.get("note", "")), name, uid]
        rows.append(row)
        save_rows(rows)
    return {"ok": True, "lit": lit, "cheat": cheat, "row": row}


def thumbs(ids):
    out = {}
    for tid in (ids or [])[:60]:
        tid = str(tid)
        if not tid.startswith("t_"):
            continue
        p = os.path.join(THUMBS, tid[2:])
        if os.path.exists(p):
            with open(p, "rb") as f:
                out[tid] = base64.b64encode(f.read()).decode()
    return {"ok": True, "thumbs": out}


def photo(fid):
    fid = str(fid or "")
    if not fid.startswith("f_"):
        return {"ok": False, "error": "no_id"}
    p = os.path.join(PHOTOS, fid[2:])
    if not os.path.exists(p):
        return {"ok": False, "error": "not_found"}
    with open(p, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    return {"ok": True, "id": fid, "name": fid[2:], "mime": "image/jpeg", "data": data}


def handle(req, via_get):
    if not isinstance(req, dict) or str(req.get("key", "")) != KEY:
        return {"ok": False, "error": "bad_key"}
    action = req.get("action")
    if action == "ping":
        return {"ok": True}
    if action == "list":
        with LOCK:
            return {"ok": True, "rows": load_rows()}
    if action == "thumbs":
        return thumbs(req.get("ids"))
    if action == "photo":
        return photo(req.get("id"))
    if action == "find":
        uid = str(req.get("uid", ""))
        with LOCK:
            hit = next((r for r in load_rows() if len(r) > 9 and uid and r[9] == uid), None)
        return {"ok": True, "row": hit}
    if action == "upload":
        return {"ok": False, "error": "upload_needs_post"} if via_get else upload(req)
    return {"ok": False, "error": "bad_action"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # MOCK_BLOCK_FETCH=1 模擬 iPhone Safari 擋掉跨網域 fetch：
    # 對 text/plain 的 POST 故意不給 CORS 標頭，逼 App 走備援
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api":
            q = parse_qs(u.query)
            cb = (q.get("cb") or [""])[0]
            try:
                req = json.loads((q.get("p") or ["{}"])[0])
            except Exception:
                req = None
            res = handle(req, via_get=True) if req is not None else {"ok": False, "error": "bad_json"}
            return self.reply(res, cb=cb)
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8")
        ctype = self.headers.get("Content-Type", "")
        try:
            if ctype.startswith("application/x-www-form-urlencoded"):
                req = json.loads(parse_qs(raw)["payload"][0])
            else:
                req = json.loads(raw)
        except Exception:
            return self.reply({"ok": False, "error": "bad_json"})
        cors = not (os.environ.get("MOCK_BLOCK_FETCH") and ctype.startswith("text/plain"))
        return self.reply(handle(req, via_get=False), cors=cors)

    def reply(self, obj, cb="", cors=True):
        if cb:
            body = f"{cb}({json.dumps(obj)});".encode("utf-8")
            ctype = "application/javascript"
        else:
            body = json.dumps(obj).encode("utf-8")
            ctype = "application/json"
        self.send_response(200)
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"1440 mock api: http://localhost:{port}/#k={KEY}&api=http://localhost:{port}/api")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
