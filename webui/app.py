"""Live2D Studio: serve models, their runtime manifests and optional chat."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

ROOT = Path(__file__).resolve().parent
ASSET_ROOT = Path(os.environ.get("ASSET_DIR", str(ROOT.parent / "asset"))).resolve()
STATIC_ROOT = ROOT / "static"
LLM_API_BASE = os.environ.get("LLM_API_BASE", "").strip().rstrip("/")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "").strip()
LLM_MODEL = os.environ.get("LLM_MODEL", "").strip()
CHAT_READY = bool(LLM_API_BASE and LLM_MODEL)
logger = logging.getLogger("live2d")
chat_slots = asyncio.Semaphore(4)

app = FastAPI(title="Live2D Studio", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_ROOT), name="static")


def models() -> dict[str, Path]:
    if not ASSET_ROOT.is_dir():
        return {}
    return {
        hashlib.sha256(path.relative_to(ASSET_ROOT).as_posix().encode()).hexdigest()[:16]: path
        for path in sorted(ASSET_ROOT.rglob("*.model3.json"))
        if path.resolve().is_relative_to(ASSET_ROOT)
    }


def model_path(model_id: str) -> Path:
    path = models().get(model_id)
    if path is None:
        raise HTTPException(404, "未找到模型")
    return path


class MissingModelAsset(ValueError):
    def __init__(self, path: str):
        self.path = path
        super().__init__(f"缺少模型文件：{path}")


def asset_url(path: Path) -> str:
    path = path.resolve()
    if not path.is_relative_to(ASSET_ROOT):
        raise ValueError("模型引用超出 asset 目录")
    if not path.is_file():
        raise MissingModelAsset(path.relative_to(ASSET_ROOT).as_posix())
    return "/assets/" + quote(path.relative_to(ASSET_ROOT).as_posix(), safe="/")


def load_manifest(path: Path) -> dict:
    manifest = json.loads(path.read_text(encoding="utf-8-sig"))
    refs = manifest["FileReferences"]
    # Register files omitted by VTube Studio exports without changing the originals.
    if not refs.get("Expressions"):
        refs["Expressions"] = [
            {"Name": p.name.removesuffix(".exp3.json"), "File": p.relative_to(path.parent).as_posix()}
            for p in sorted(path.parent.rglob("*.exp3.json"))
        ]
    if not refs.get("Motions"):
        idle, actions = [], []
        for p in sorted(path.parent.rglob("*.motion3.json")):
            item = {"File": p.relative_to(path.parent).as_posix(), "FadeInTime": 0.35, "FadeOutTime": 0.35}
            (idle if p.name.lower().startswith("idle.") else actions).append(item)
        refs["Motions"] = {"Idle": idle, "Actions": actions}
    for key in ("Moc", "Physics", "Pose", "DisplayInfo", "UserData"):
        if refs.get(key):
            refs[key] = asset_url(path.parent / refs[key])
    refs["Textures"] = [asset_url(path.parent / p) for p in refs["Textures"]]
    for expr in refs.get("Expressions", []):
        expr["File"] = asset_url(path.parent / expr["File"])
    for group in refs.get("Motions", {}).values():
        for motion in group:
            for key in ("File", "Sound"):
                if motion.get(key):
                    motion[key] = asset_url(path.parent / motion[key])
    manifest["url"] = f"/api/models/{hashlib.sha256(path.relative_to(ASSET_ROOT).as_posix().encode()).hexdigest()[:16]}/model.json"
    return manifest


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_ROOT / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
def health():
    return {"status": "ok", "models": len(models()), "chat_mode": "connected" if CHAT_READY else "demo"}


@app.get("/api/models")
def list_models():
    result, errors = [], []
    for model_id, path in models().items():
        try:
            manifest = load_manifest(path)
            refs = manifest["FileReferences"]
            preview = path.with_name(path.name.removesuffix(".model3.json") + ".png")
            result.append({
                "id": model_id,
                "name": path.name.removesuffix(".model3.json"),
                "url": f"/api/models/{model_id}/model.json",
                "preview": asset_url(preview) if preview.is_file() else None,
                "expressions": [e["Name"] for e in refs.get("Expressions", [])],
                "motions": [
                    {"name": Path(urlsplit(m["File"]).path).name.removesuffix(".motion3.json"), "group": group, "index": i}
                    for group, items in refs.get("Motions", {}).items()
                    for i, m in enumerate(items) if group != "Idle"
                ],
            })
        except (ValueError, KeyError, TypeError, OSError) as exc:
            logger.warning("Skipping invalid model %s: %s", path.name, exc)
            errors.append({
                "id": model_id,
                "name": path.name.removesuffix(".model3.json"),
                "source": path.relative_to(ASSET_ROOT).as_posix(),
                "error": str(exc) if isinstance(exc, MissingModelAsset) else "模型引用缺失或配置无效",
                "missing": [exc.path] if isinstance(exc, MissingModelAsset) else [],
            })
    # Decode labels only; asset URLs stay percent-encoded for Chinese filenames.
    from urllib.parse import unquote
    for item in result:
        for motion in item["motions"]:
            motion["name"] = unquote(motion["name"])
    return {"models": result, "errors": errors, "chat_mode": "connected" if CHAT_READY else "demo"}


@app.get("/api/models/{model_id}/model.json")
def get_manifest(model_id: str):
    try:
        return load_manifest(model_path(model_id))
    except MissingModelAsset as exc:
        raise HTTPException(422, str(exc)) from None
    except (ValueError, KeyError, TypeError, OSError):
        raise HTTPException(422, "模型配置或引用文件不完整") from None


@app.get("/assets/{filename:path}", include_in_schema=False)
def get_asset(filename: str):
    path = (ASSET_ROOT / filename).resolve()
    allowed = (".moc3", ".model3.json", ".physics3.json", ".pose3.json", ".exp3.json", ".motion3.json", ".cdi3.json", ".userdata3.json", ".png", ".jpg", ".jpeg", ".webp", ".wav", ".mp3", ".ogg")
    if not path.is_relative_to(ASSET_ROOT) or not path.is_file() or not path.name.lower().endswith(allowed):
        raise HTTPException(404, "未找到资源")
    return FileResponse(path)


class Message(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def check_history(self):
        if self.messages[-1].role != "user" or sum(len(m.content) for m in self.messages) > 24000:
            raise ValueError("消息历史过长，或最后一条消息不是用户消息")
        return self


def request_completion(messages: list[dict]) -> str:
    if urlsplit(LLM_API_BASE).scheme not in {"http", "https"}:
        raise ValueError("LLM_API_BASE must use HTTP or HTTPS")
    body = json.dumps({"model": LLM_MODEL, "messages": [
        {"role": "system", "content": "你是大肥鱼，一个温柔、有一点俏皮的虚拟伙伴。用简洁自然的中文陪用户聊天。"},
        *messages,
    ], "max_tokens": 600}).encode()
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"
    req = Request(LLM_API_BASE + "/chat/completions", data=body, headers=headers, method="POST")
    with urlopen(req, timeout=40) as response:
        data = json.loads(response.read(2_000_000))
    content = data["choices"][0]["message"]["content"]
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Empty completion")
    return content.strip()


@app.post("/api/chat")
async def chat(payload: ChatRequest):
    if not CHAT_READY:
        return {"mode": "demo", "reply": "收到你的消息啦！现在是互动演示模式，我可以陪你试试表情和动作。配置 LLM_API_BASE 和 LLM_MODEL 后，就能开始真正的 AI 对话。"}
    try:
        async with chat_slots:
            reply = await asyncio.to_thread(request_completion, [m.model_dump() for m in payload.messages])
        return {"mode": "connected", "reply": reply}
    except (HTTPError, URLError, TimeoutError, ValueError, KeyError, IndexError, TypeError, OSError) as exc:
        logger.warning("Chat provider failed: %s", type(exc).__name__)
        raise HTTPException(502, "对话服务暂时不可用，请检查服务端的接口配置后重试。") from None

