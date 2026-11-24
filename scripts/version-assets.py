"""Stamp local CSS and JavaScript URLs in the staged Pages site."""
import re
import sys
from pathlib import Path

site = Path(sys.argv[1])
revision = sys.argv[2]
if not re.fullmatch('[0-9a-f]{40}', revision):
    raise ValueError('Expected a full Git commit hash')

# Includes module imports, the MP3 worker and its importScripts dependency.
url = re.compile(r"""(["'])([./\w-]+\.(?:css|js))\1""")


def version(match):
    quote, path = match.groups()
    if not (site / path).is_file():
        raise FileNotFoundError(path)
    return f'{quote}{path}?v={revision}{quote}'


for entry in [site / 'index.html', *site.glob('*.js')]:
    entry.write_text(url.sub(version, entry.read_text()))
