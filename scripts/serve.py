"""Serve the static editor, including browser modules and WASM, on any OS."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class SiteHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm'}


def create_server(bind, port):
    site = Path(__file__).resolve().parents[1] / 'site'
    return ThreadingHTTPServer((bind, port), partial(SiteHandler, directory=site))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bind', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8213)
    args = parser.parse_args()
    with create_server(args.bind, args.port) as server:
        print(f'MixLab: http://localhost:{args.port}/', flush=True)
        server.serve_forever()
