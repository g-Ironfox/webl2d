# Live2D Studio

中文 Live2D 互动工作台。FastAPI 提供模型发现、运行配置和静态文件，前端使用 PixiJS + Cubism，在浏览器中渲染模型。无需 Node 构建步骤。

## Docker 启动

```powershell
docker compose up -d --build
```

默认访问 `http://localhost:8687`，接口文档位于 `/docs`。
`asset` 目录以只读方式挂载进容器，模型不会被复制到镜像中。
页面所需的三个运行库已保存在 `webui/static/vendor`，打开网页无需请求外部 CDN。

可选：将 `.env.example` 复制为 `.env` 并修改端口或 AI 配置。已有 `.env` 可以继续使用，旧的数据库变量不会被读取。这个工作台只启动一个 FastAPI 容器。

开发模式：

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

更新前端或后端后，普通部署重新运行 `docker compose up -d --build webui`。
开发模式直接挂载 `webui` 并启用 Python 热重载，前端更改后刷新浏览器即可。

## 本地启动

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r webui/requirements.txt
.\.venv\Scripts\python -m uvicorn app:app --app-dir webui --host 127.0.0.1 --port 8000 --reload
```

然后打开 `http://127.0.0.1:8000`。本地启动不自动读取 `.env`；需要 AI 对话时先设置对应的环境变量，或使用 uvicorn 的 `--env-file .env`。

## 模型与互动

将模型按目录放在 `asset` 中，保持 `.model3.json` 内的文件相对路径正确。例如：

```text
asset/
  DeepSeek/
    大肥鱼.model3.json
    大肥鱼.moc3
    大肥鱼.physics3.json
    大肥鱼.4096/texture_00.png
    Exp3/*.exp3.json
    Animation/*.motion3.json
```

后端递归发现 `.model3.json`。若原配置未登记表情和动作，自动收集模型目录下的相关文件，并将 `IDLE.motion3.json` 注册为待机动作。动态配置通过 API 返回，原始模型不被改写。中文文件名会被正确编码。缺失引用的模型会跳过，并在模型列表中返回错误提示。

支持：

- 模型切换、表情和动作播放。
- 鼠标视线跟随、待机呼吸、拖动模型、滚轮与滑块缩放、重置视图。
- 五种舞台背景、全屏舞台、透明 PNG 截图。
- 桌面与手机布局、中文对话面板、演示回复或可选 AI 对话。

## 正常体型鼻子黑块修复

大肥鱼正常体型的鼻子图层 `ArtMesh246` 和 `ArtMesh682` 使用黑色原始纹理，并在模型中设置 Multiply Color 为 `(0, 0, 0)`，Screen Color 为接近肤色的 `(1, 0.9647, 0.9608)`。

`pixi-live2d-display 0.4.0` 的默认片元着色器未应用这两组逐图层颜色，导致鼻子出现黑色块。`webui/static/cubism-colors.js` 为固定版本渲染库补上相应着色支持，适用于普通、遮罩和反向遮罩绘制，同时保留遮罩生成流程。

修复使用模型每帧提供的颜色数据，不删除鼻子图层、不修改模型或纹理。参考 Live2D 官方说明：
https://docs.live2d.com/en/cubism-sdk-manual/multiply-color-screen-color-web/

![模型数据重建对比，左侧忽略染色，右侧应用染色](docs/nose-color-comparison.png)

此图为模型网格与纹理的离线重建，用于定位和验证颜色问题，并非浏览器截图。

## DeepSeek娘模型与默认站姿

完整模型现位于 `asset/DeepSeekNiang_v4`，包含 `.moc3`、14 页纹理、38 个表情、待机和 13 个可选动作。刷新页面后可在“当前模型”中选择 `DeepSeekNiang`。模型新增或替换由只读 asset 挂载生效，无需为资源单独重建镜像。

该模型原默认姿态双臂伸直、左右对称。网页默认开启“自然站姿”：一侧屈肘，将手放在围裙前，另一侧手臂稍低，手腕角度分别调整。静态站姿从首个渲染帧生效，不额外叠加手臂摆动，也不受“待机呼吸”开关影响。显式动作和招手、捧碗、加油手势仍然优先，结束后渐变回默认站姿；关闭“自然站姿”则渐变恢复模型原有姿态。此模型没有单独的手指关节参数，指形保持原画。

![默认站姿调整前后](docs/default-pose-comparison.png)

此图使用模型的实际网格与纹理离线重建，左侧为上一版收拢双臂的姿态，右侧为新的默认站姿；并非浏览器截图。

实现位于 `webui/static/relaxed-arms.js`，通过原生参数和肩部范围识别这个骨架；其他模型沿用自己的待机。无需修改模型文件。

有 Node.js 时运行手臂回归检查：

```powershell
node --input-type=module -e "import('./tests/relaxed-arms.test.mjs').then(async m => console.log(await m.runArmTests()))"
```

检查使用真实 `.moc3`，覆盖首帧屈肘、左右不对称、不同待机动作下静态站姿一致、手臂网格位置、参数范围、开关渐变、手势与动作优先级、长时间停顿和销毁清理。

## AI 对话（可选）

在 `.env` 中配置兼容 Chat Completions 的服务：

```dotenv
LLM_API_BASE=https://your-provider.example/v1
LLM_API_KEY=your-key
LLM_MODEL=your-model
```

程序在根地址后追加 `/chat/completions`，密钥仅由服务端使用。
Docker 内连接宿主机服务可使用 `http://host.docker.internal:端口/v1`。
未配置根地址和模型名时，页面明确显示演示模式；演示回复不调用 AI。
对话记录只保留在当前网页内存，刷新页面后清空。

## 接口

| 路径 | 用途 |
| --- | --- |
| `GET /api/health` | 服务状态、模型数量和对话模式 |
| `GET /api/models` | 可用模型、表情、动作及配置错误 |
| `GET /api/models/{id}/model.json` | 包含运行资源地址的模型配置 |
| `GET /assets/{path}` | 模型运行所需资源 |
| `POST /api/chat` | 演示或 AI 对话 |

## 验证

Python 集成检查不需要额外测试依赖：

```powershell
python -m unittest discover -s tests -p test_app.py -v
```

有 Node.js 时，可运行染色回归检查，包含真实 moc3 的鼻子颜色、三类着色器、混合模式与遮罩：

```powershell
node --input-type=module -e "import('./tests/cubism-colors.test.mjs').then(async m => console.log(await m.runColorTests()))"
```

浏览器需要支持 WebGL。本次开发环境没有可连接的浏览器，已验证模型 Core 加载、颜色计算与接口；浏览器全页视觉和鼠标操作仍需在实际页面验收。

## 运行库与许可

如需重新获取运行库：`python scripts/fetch_vendor.py`。
运行库版本及来源见 `webui/static/vendor/README.md`。
模型遵循原作者授权；Cubism Core 遵循 Live2D 对应许可，发布时保留其许可声明。
