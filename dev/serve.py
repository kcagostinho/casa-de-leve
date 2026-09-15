"""Servidor estático de desenvolvimento sem cache (para ver alterações na hora).

Uso: python dev/serve.py [porta]
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # menos ruído no log
        if "404" in fmt % args or "500" in fmt % args:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    handler = partial(NoCacheHandler, directory=str(ROOT))
    print(f"Servindo {ROOT} em http://127.0.0.1:{port}/mock.html")
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
