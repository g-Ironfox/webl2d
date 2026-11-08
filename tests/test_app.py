"""Integration checks through ASGI, without extra test dependencies."""
import asyncio
import importlib.util
import json
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("studio_app", ROOT / "webui/app.py")
studio = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = studio
spec.loader.exec_module(studio)


async def call(method, path, body=None, capture=True):
    output, status, headers, size = bytearray(), 0, {}, 0
    raw = b"" if body is None else json.dumps(body).encode()
    received = False

    async def receive():
        nonlocal received
        if not received:
            received = True
            return {"type": "http.request", "body": raw, "more_body": False}
        await asyncio.Future()

    async def send(message):
        nonlocal status, headers, size
        if message["type"] == "http.response.start":
            status = message["status"]
            headers = {k.decode(): v.decode() for k, v in message["headers"]}
        elif message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            size += len(chunk)
            if capture:
                output.extend(chunk)

    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1", "method": method, "scheme": "http", "path": unquote(path),
        "raw_path": path.encode(), "query_string": b"", "root_path": "",
        "headers": [(b"content-type", b"application/json")],
        "server": ("localhost", 8000), "client": ("127.0.0.1", 12345),
    }
    await studio.app(scope, receive, send)
    return status, headers, bytes(output), size


class StudioTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_model_manifest_and_every_reference(self):
        status, _, body, _ = await call("GET", "/api/models")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertTrue(data["models"])
        item = next(m for m in data["models"] if m["name"] == "大肥鱼")
        self.assertEqual(len(item["expressions"]), 23)
        self.assertEqual(len(item["motions"]), 7)
        status, _, body, _ = await call("GET", item["url"])
        self.assertEqual(status, 200)
        refs = json.loads(body)["FileReferences"]
        self.assertEqual(len(refs["Motions"]["Idle"]), 1)
        urls = [refs[k] for k in ("Moc", "Physics", "DisplayInfo")]
        urls += refs["Textures"] + [e["File"] for e in refs["Expressions"]]
        urls += [m["File"] for group in refs["Motions"].values() for m in group]
        urls += [item["preview"]]
        for url in urls:
            with self.subTest(url=url):
                status, _, _, size = await call("GET", url, capture=False)
                self.assertEqual(status, 200)
                self.assertGreater(size, 0)

    async def test_page_and_all_scripts(self):
        for url in ("/", "/static/style.css", "/static/app.js", "/static/cubism-colors.js", "/static/relaxed-arms.js", "/static/vendor/pixi.min.js", "/static/vendor/cubism4.min.js", "/static/vendor/live2dcubismcore.min.js"):
            with self.subTest(url=url):
                status, headers, body, size = await call("GET", url)
                self.assertEqual(status, 200)
                self.assertGreater(size, 100)
                if url == "/":
                    self.assertEqual(headers["cache-control"], "no-cache")
                    self.assertLess(body.index(b"cubism4.min.js"), body.index(b"cubism-colors.js"))
                    self.assertLess(body.index(b"cubism-colors.js"), body.index(b"/static/app.js"))
                    self.assertLess(body.index(b"relaxed-arms.js"), body.index(b"/static/app.js"))
                    self.assertIn(b'id="relaxed-arms"', body)

    async def test_private_files_and_traversal_are_not_served(self):
        for url in ("/assets/../.env", "/assets/%2e%2e/webui/app.py", "/assets/DeepSeek/大肥鱼.vtube.json", "/assets/psd/大肥鱼公皮分享拆分.psd", "/api/models/invalid/model.json"):
            with self.subTest(url=url):
                status, _, _, _ = await call("GET", url)
                self.assertEqual(status, 404)

    async def test_empty_or_broken_models(self):
        with tempfile.TemporaryDirectory(dir=ROOT / "tests") as directory:
            with patch.object(studio, "ASSET_ROOT", Path(directory)):
                status, _, body, _ = await call("GET", "/api/models")
                self.assertEqual(json.loads(body)["models"], [])
                (Path(directory) / "broken.model3.json").write_text('{"FileReferences": {"Moc": "missing.moc3", "Textures": []}}')
                status, _, body, _ = await call("GET", "/api/models")
                self.assertEqual(status, 200)
                self.assertEqual(len(json.loads(body)["errors"]), 1)
                issue = json.loads(body)["errors"][0]
                self.assertEqual(issue["missing"], ["missing.moc3"])
                self.assertEqual(issue["source"], "broken.model3.json")
                self.assertIn("missing.moc3", issue["error"])
                self.assertNotIn(directory, issue["error"])
                status, _, body, _ = await call("GET", f"/api/models/{issue['id']}/model.json")
                self.assertEqual(status, 422)
                self.assertIn("missing.moc3", json.loads(body)["detail"])
                # API registration must recover without edits when the required file appears.
                # This synthetic header tests discovery, not Cubism binary compatibility.
                (Path(directory) / "missing.moc3").write_bytes(b"MOC3")
                status, _, body, _ = await call("GET", "/api/models")
                recovered = json.loads(body)
                self.assertEqual(recovered["errors"], [])
                self.assertEqual(len(recovered["models"]), 1)
                self.assertEqual(recovered["models"][0]["id"], issue["id"])


    async def test_chat_demo_and_validation(self):
        with patch.object(studio, "CHAT_READY", False):
            status, _, body, _ = await call("POST", "/api/chat", {"messages": [{"role": "user", "content": "你好"}]})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["mode"], "demo")
        for payload in ({"messages": []}, {"messages": [{"role": "system", "content": "x"}]}, {"messages": [{"role": "assistant", "content": "x"}]}, {"messages": [{"role": "user", "content": "x" * 4001}]}):
            status, _, _, _ = await call("POST", "/api/chat", payload)
            self.assertEqual(status, 422)

    async def test_chat_provider_errors_are_redacted(self):
        with patch.object(studio, "CHAT_READY", True), patch.object(studio, "request_completion", side_effect=ValueError("secret-api-key")):
            status, _, body, _ = await call("POST", "/api/chat", {"messages": [{"role": "user", "content": "你好"}]})
            self.assertEqual(status, 502)
            self.assertNotIn(b"secret-api-key", body)
        with patch.object(studio, "CHAT_READY", True), patch.object(studio, "request_completion", return_value="你好呀"):
            status, _, body, _ = await call("POST", "/api/chat", {"messages": [{"role": "user", "content": "你好"}]})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["reply"], "你好呀")


if __name__ == "__main__":
    unittest.main()

