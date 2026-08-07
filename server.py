"""
Gridiron Edge local sync server.

Serves the app and accepts one POST: the draft state the Chrome extension
scrapes out of the live ESPN room. That makes it a trust boundary, and it was
originally wide open in three ways at once -- it bound every interface, it
stamped `Access-Control-Allow-Origin: *` on every response, and it served the
whole working directory including `.git`. Any machine on the same Wi-Fi could
read the user's league data, and any website the user visited could both read it
and overwrite it, which fed straight into the page's renderers.

The rules now:

  * bind loopback only -- nothing off this machine can reach it
  * echo CORS only to the extension and to the app's own origin
  * serve an explicit allowlist of paths, never a directory tree
  * cap and shape-check the sync body before writing, and write atomically

Run: python3 server.py   then open http://localhost:8000
"""
import http.server
import json
import os
import posixpath
import socketserver
import tempfile
import time
from urllib.parse import urlparse

PORT = 8000

# Loopback only. The previous '' bound 0.0.0.0, which put a directory listing of
# the whole project -- and the user's private league file -- on the local network.
HOST = '127.0.0.1'

# Only these origins may talk to us, and only the app's own origin may write.
# A wildcard here let any page the user happened to visit read every served file
# and POST a replacement league.
ALLOWED_ORIGINS = {
    f'http://localhost:{PORT}',
    f'http://127.0.0.1:{PORT}',
}
CHROME_EXTENSION_PREFIX = 'chrome-extension://'

# Everything the app actually needs. Serving the working directory exposed
# .git/config and auto-generated directory indexes.
ALLOWED_FILES = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/imported_league.json': 'imported_league.json',
    '/favicon.ico': None,          # answered 404 quietly rather than searched for
}
ALLOWED_DIRS = ('css/', 'js/', 'data/')

MAX_SYNC_BYTES = 5 * 1024 * 1024   # a draft payload is ~30KB; this is generous


def _is_allowed_origin(origin):
    if not origin:
        return False
    return origin in ALLOWED_ORIGINS or origin.startswith(CHROME_EXTENSION_PREFIX)


def _looks_like_a_league(data):
    """
    Enough of a shape check that a stray POST cannot blank a live draft.

    The endpoint used to accept any valid JSON and write it straight over
    imported_league.json, so `null` or `{}` would erase a draft in progress.
    """
    if not isinstance(data, dict):
        return False
    if not data.get('leagueId'):
        return False
    teams = data.get('teams')
    return isinstance(teams, list) and len(teams) > 0


class GridironServer(http.server.SimpleHTTPRequestHandler):
    # Quieter than the default, which logs every asset request.
    def log_message(self, fmt, *args):
        if self.path.startswith('/health'):
            return
        super().log_message(fmt, *args)

    def _cors(self):
        origin = self.headers.get('Origin')
        if _is_allowed_origin(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def end_headers(self):
        self._cors()
        super().end_headers()

    def do_OPTIONS(self):
        origin = self.headers.get('Origin')
        self.send_response(200 if _is_allowed_origin(origin) else 403)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def translate_path(self, path):
        """
        Resolve only allowlisted paths, and only under this directory.

        SimpleHTTPRequestHandler already blocks `..` traversal, but it happily
        serves everything else in the tree -- including .git. This narrows it to
        the files the app loads.
        """
        clean = posixpath.normpath(urlparse(path).path)
        root = os.getcwd()

        if clean in ALLOWED_FILES:
            target = ALLOWED_FILES[clean]
            return os.path.join(root, target) if target else ''

        rel = clean.lstrip('/')
        if any(rel.startswith(d) for d in ALLOWED_DIRS):
            resolved = os.path.realpath(os.path.join(root, rel))
            # realpath collapses any symlink that points outside the project.
            if resolved.startswith(os.path.realpath(root) + os.sep):
                return resolved
        return ''

    def list_directory(self, path):
        self.send_error(403, 'Directory listing is disabled')
        return None

    def do_GET(self):
        """
        /health lets the app tell three states apart that otherwise look alike:
        the server is down, the server is up but the extension has never synced,
        and everything is working. Without it a stale league file is
        indistinguishable from a live one.
        """
        if self.path.startswith('/health'):
            sync_path = os.path.join(os.getcwd(), 'imported_league.json')
            exists = os.path.exists(sync_path)
            payload = {
                'status': 'ok',
                'serverTime': time.time(),
                'syncFileExists': exists,
                'syncFileAgeSeconds': (time.time() - os.path.getmtime(sync_path))
                                      if exists else None,
            }
            self._send_json(200, payload)
            return

        if not self.translate_path(self.path):
            self.send_error(404, 'Not found')
            return
        super().do_GET()

    def do_POST(self):
        if self.path != '/sync':
            self.send_error(404, 'Not found')
            return

        # A write must come from somewhere we recognise. Without this, any page
        # in the user's browser could replace the draft the app is reading.
        if not _is_allowed_origin(self.headers.get('Origin')):
            self._send_json(403, {'status': 'error'})
            return

        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            self._send_json(400, {'status': 'error'})
            return
        if length <= 0 or length > MAX_SYNC_BYTES:
            self._send_json(413, {'status': 'error'})
            return

        try:
            body = self.rfile.read(length)
            data = json.loads(body.decode('utf-8'))
        except Exception as e:
            # The message stays server-side: it used to be echoed to the caller,
            # handing filesystem paths to anyone who could reach this endpoint.
            print(f'[Sync Server] Malformed sync body: {e}')
            self._send_json(400, {'status': 'error'})
            return

        if not _looks_like_a_league(data):
            print('[Sync Server] Rejected a payload that is not a league')
            self._send_json(400, {'status': 'error'})
            return

        try:
            self._write_atomically(data)
        except Exception as e:
            print(f'[Sync Server] Could not write sync file: {e}')
            self._send_json(500, {'status': 'error'})
            return

        teams = len(data.get('teams') or [])
        picks = len(((data.get('draftDetail') or {}).get('picks')) or [])
        print(f'[Sync Server] Synced league {data.get("leagueId")}: {teams} teams, {picks} picks')
        self._send_json(200, {'status': 'success'})

    def _write_atomically(self, data):
        """
        Temp file plus rename, so a reader polling every 3 seconds can never
        catch a half-written file.
        """
        root = os.getcwd()
        target = os.path.join(root, 'imported_league.json')
        fd, tmp = tempfile.mkstemp(dir=root, prefix='.sync-', suffix='.json')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            os.replace(tmp, target)
        except Exception:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def _send_json(self, code, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == '__main__':
    print('=' * 60)
    print(f' Gridiron Edge local server on http://localhost:{PORT}')
    print(f' Bound to {HOST} only — not reachable from the network.')
    print('=' * 60)

    httpd = ThreadingHTTPServer((HOST, PORT), GridironServer)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nStopping Gridiron Edge server.')
        httpd.server_close()
