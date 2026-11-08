"""Download pinned browser runtimes from their original distributions.

Run from any directory: python scripts/fetch_vendor.py
Cubism Core is distributed under Live2D's own license; see vendor/README.md.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen

TARGET = Path(__file__).resolve().parents[1] / "webui" / "static" / "vendor"
FILES = {
    "pixi.min.js": ["https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js", "https://unpkg.com/pixi.js@6.5.10/dist/browser/pixi.min.js"],
    "cubism4.min.js": ["https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js", "https://unpkg.com/pixi-live2d-display@0.4.0/dist/cubism4.min.js"],
    "live2dcubismcore.min.js": ["https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"],
}


def download(item):
    name, sources = item
    path = TARGET / name
    if path.is_file() and path.stat().st_size > 10000:
        return f"{name}: already present"
    failures = []
    for url in sources:
        try:
            request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://cubism.live2d.com/"})
            with urlopen(request, timeout=45) as response:
                data = response.read()
            if len(data) < 10000 or b"<html" in data[:200].lower():
                raise ValueError("Response is not a JavaScript runtime")
            path.write_bytes(data)
            return f"{name}: downloaded {len(data)} bytes"
        except Exception as exc:
            failures.append(f"{url}: {exc}")
    raise RuntimeError("\n".join(failures))


if __name__ == "__main__":
    TARGET.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        for result in pool.map(download, FILES.items()):
            print(result)
