"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { app: null, model: null, models: [], current: null, zoom: 1, follow: true, idle: true, breathAmplitude: 1, breathParameters: [], relaxedArms: true, generation: 0, messages: [], busy: false, offset: { x: 0, y: 0 }, selectedExpression: null };
  const icons = { "脸红": "◡", "爱心眼": "♡", "流泪": "◞", "圈圈眼": "◎", "屑屑眼": "⌁", "黑脸": "◒", "加载": "◌", "兔牙": "⌣", "＞＜": "✧", "流冷汗": "◔" };
  let toastTimer;
  function toast(text) { $("toast").textContent = text; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4200); }
  async function request(url, options) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(55000) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "请求失败，请稍后重试。");
    return data;
  }
  function setLoading(title, detail, error = false) {
    $("loading").hidden = false;
    $("loading").classList.toggle("error", error);
    $("loading-title").textContent = title;
    $("loading-detail").textContent = detail;
    $("retry").hidden = !error;
  }
  function fit() {
    if (!state.model || !state.app) return;
    const { width, height } = $("stage").getBoundingClientRect();
    if (!width || !height) return;
    state.app.renderer.resize(width, height);
    const model = state.model;
    const scale = Math.min(width * .90 / model.internalModel.width, height * .91 / model.internalModel.height);
    model.scale.set(scale * state.zoom);
    model.position.set(width / 2 + state.offset.x, height * .52 + state.offset.y);
  }
  function setZoom(value) {
    const zoom = Math.max(50, Math.min(180, Number(value)));
    state.zoom = zoom / 100;
    $("zoom").value = String(zoom);
    $("zoom-value").value = `${zoom}%`;
    fit();
  }
  function resetView() { state.offset = { x: 0, y: 0 }; setZoom(100); }
  function applyBreathAmplitude() {
    for (const { parameter, peak } of state.breathParameters) parameter.peak = peak * state.breathAmplitude;
  }
  function setTab(name) {
    for (const tab of ["expressions", "motions"]) {
      const active = name === tab;
      $(`tab-${tab}`).classList.toggle("active", active);
      $(`tab-${tab}`).setAttribute("aria-selected", String(active));
      $(`tab-${tab}`).tabIndex = active ? 0 : -1;
      $(`${tab}-panel`).hidden = !active;
    }
  }
  function renderControls(info) {
    $("expression-count").textContent = info.expressions.length;
    $("motion-count").textContent = info.motions.length;
    $("expression-list").replaceChildren();
    for (const name of ["默认", ...info.expressions]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "expression-button";
      button.textContent = `${icons[name] || (name === "默认" ? "☺" : "✧")}  ${name}`;
      button.title = name;
      button.setAttribute("aria-pressed", String(name === "默认"));
      button.classList.toggle("selected", name === "默认");
      button.addEventListener("click", async () => {
        if (!state.model) return toast("模型还在准备中，请稍等。");
        const model = state.model;
        try {
          if (name === "默认") {
            const manager = model.internalModel.motionManager.expressionManager;
            if (manager) manager.resetExpression();
          } else if (!(await model.expression(name))) throw new Error("表情文件暂时无法加载");
          if (state.model !== model) return;
          state.selectedExpression = name;
          for (const child of $("expression-list").children) {
            const active = child === button;
            child.classList.toggle("selected", active);
            child.setAttribute("aria-pressed", String(active));
          }
        } catch (error) { toast(`表情切换失败：${error.message}`); }
      });
      $("expression-list").append(button);
    }
    $("motion-list").replaceChildren();
    for (const motion of info.motions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "motion-button";
      const name = document.createElement("span"); name.textContent = motion.name;
      const arrow = document.createElement("span"); arrow.textContent = "▷";
      button.append(name, arrow);
      button.addEventListener("click", async () => {
        if (!state.model) return toast("模型还在准备中，请稍等。");
        button.disabled = true;
        try {
          if (!(await state.model.motion(motion.group, motion.index, 3))) throw new Error("动作没有开始播放");
          toast(`正在播放：${motion.name}`);
        } catch (error) { toast(`动作播放失败：${error.message}`); }
        finally { button.disabled = false; }
      });
      $("motion-list").append(button);
    }
    if (!info.motions.length) { const empty = document.createElement("p"); empty.className = "panel-tip"; empty.textContent = "这个模型还没有动作文件。"; $("motion-list").append(empty); }
  }
  async function loadModel(info) {
    const generation = ++state.generation;
    state.current = info;
    state.selectedExpression = null;
    $("capture").disabled = true;
    $("relaxed-arms-setting").hidden = true;
    $("render-status").textContent = "加载中";
    $("character-status").textContent = "准备见面中";
    setLoading("正在唤醒你的伙伴", "首次加载需要读取模型和纹理，请稍等片刻");
    $("stage-name").textContent = info.name;
    $("character-name").textContent = info.name;
    $("greeting-name").textContent = info.name;
    $("character-avatar").replaceChildren();
    if (info.preview) { const image = new Image(); image.src = info.preview; image.alt = `${info.name}头像`; $("character-avatar").append(image); }
    else $("character-avatar").textContent = "✦";
    renderControls(info);
    if (state.model) { state.app.stage.removeChild(state.model); state.model.destroy({ children: true, texture: true, baseTexture: true }); state.model = null; }
    state.breathParameters = [];
    $("breath-amplitude").disabled = false;
    $("breath-amplitude").removeAttribute("title");
    try {
      if (!window.Live2DCubismCore || !window.PIXI?.live2d) throw new Error("Live2D 运行库尚未就绪，请确认 static/vendor 中的三个运行库已下载完整。");
      if (!state.app) {
        state.app = new PIXI.Application({ view: $("live2d"), width: $("stage").clientWidth, height: $("stage").clientHeight, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2), preserveDrawingBuffer: true });
      }
      const model = await PIXI.live2d.Live2DModel.from(info.url, { autoInteract: false, motionPreload: "IDLE" });
      if (generation !== state.generation) { model.destroy({ children: true, texture: true, baseTexture: true }); return; }
      state.model = model;
      model.anchor.set(.5, .5);
      model.internalModel.motionManager.groups.idle = "Idle";
      // Keep idle breathing separate from user-triggered motions and expressions.
      const breath = model.internalModel.breath;
      if (breath) {
        const parameters = breath.getParameters?.() || [];
        state.breathParameters = parameters.map((parameter) => ({ parameter, peak: parameter.peak }));
        $("breath-amplitude-setting").hidden = state.breathParameters.length === 0;
        applyBreathAmplitude();
        const updateBreath = breath.updateParameters.bind(breath);
        breath.updateParameters = (...args) => { if (state.idle) updateBreath(...args); };
      }
      $("breath-amplitude").disabled = state.breathParameters.length === 0;
      if ($("breath-amplitude").disabled) $("breath-amplitude").title = "当前模型不支持待机呼吸";
      const armController = globalThis.Live2DStudio?.installRelaxedArms(model, {
        enabled: () => state.relaxedArms,
      });
      $("relaxed-arms-setting").hidden = !armController;
      state.app.stage.addChild(model);
      resetView();
      $("loading").hidden = true;
      $("render-status").textContent = "WebGL · 实时渲染";
      $("character-status").textContent = "在线，等你互动";
      $("capture").disabled = false;
    } catch (error) {
      if (generation !== state.generation) return;
      console.error("Live2D model loading failed", error);
      $("render-status").textContent = "加载失败";
      $("character-status").textContent = "等待重新连接";
      setLoading("伙伴暂时没能醒来", error.message || "请检查浏览器 WebGL 支持和模型文件后重试。", true);
    }
  }
  async function discover() {
    setLoading("正在寻找你的伙伴", "从 asset 目录读取 Live2D 模型");
    try {
      const data = await request("/api/models");
      state.models = data.models;
      $("chat-mode").textContent = data.chat_mode === "connected" ? "AI 已连接" : "演示模式";
      $("chat-note").textContent = data.chat_mode === "connected" ? "消息将发送到服务端配置的 AI 接口" : "演示回复 · 可在服务端配置 AI 对话接口";
      $("model-select").replaceChildren();
      const errors = data.errors || [];
      $("model-warning").replaceChildren();
      $("model-warning").hidden = errors.length === 0;
      for (const issue of errors) {
        const notice = document.createElement("p");
        notice.textContent = `${issue.name}：${issue.error}。补齐完整模型文件后刷新页面。`;
        $("model-warning").append(notice);
      }
      for (const info of data.models) $("model-select").add(new Option(info.name, info.id));
      for (const issue of errors) {
        const option = new Option(`${issue.name}（文件不完整）`, issue.id || "");
        option.disabled = true;
        option.title = issue.error;
        $("model-select").add(option);
      }
      if (!data.models.length) {
        $("model-select").disabled = true;
        const option = new Option("未发现可用模型", ""); $("model-select").add(option);
        throw new Error(errors.length ? errors.map((issue) => issue.error).join("；") : "请将 .model3.json、.moc3 和纹理放入 asset 目录，再重新加载。");
      }
      $("model-select").disabled = data.models.length < 2 && errors.length === 0;
      if (errors.length) toast(`有 ${errors.length} 个模型缺少文件，请查看模型选择区的提示。`);
      await loadModel(data.models[0]);
    } catch (error) {
      setLoading("还没有找到可用的伙伴", error.message, true);
    }
  }
  function addMessage(role, text, error = false) {
    const row = document.createElement("div"); row.className = `message ${role}${error ? " error" : ""}`;
    const avatar = document.createElement("span"); avatar.className = "message-avatar"; avatar.textContent = role === "user" ? "我" : "✦";
    const body = document.createElement("div");
    const name = document.createElement("span"); name.className = "message-author"; name.textContent = role === "user" ? "你" : (state.current?.name || "你的伙伴");
    const content = document.createElement("p"); content.textContent = text;
    body.append(name, content); row.append(avatar, body); $("messages").append(row);
    $("messages").scrollTop = $("messages").scrollHeight;
    return { row, content };
  }
  $("chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("chat-input").value.trim();
    if (!text || state.busy) return;
    state.busy = true; $("send").disabled = true; $("chat-input").value = "";
    addMessage("user", text);
    const pending = addMessage("assistant", "正在想怎么回复你…");
    // Retain recent complete exchanges while staying below the server's history limit.
    const history = [...state.messages.slice(-8), { role: "user", content: text }];
    try {
      const data = await request("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history }) });
      pending.content.textContent = data.reply;
      state.messages = [...history, { role: "assistant", content: data.reply.slice(0, 4000) }];
    } catch (error) {
      pending.row.classList.add("error"); pending.content.textContent = error.message || "连接超时，请再试一次。";
      $("chat-input").value = text;
    } finally {
      state.busy = false; $("send").disabled = false; $("messages").scrollTop = $("messages").scrollHeight;
    }
  });
  $("model-select").addEventListener("change", () => { const info = state.models.find((m) => m.id === $("model-select").value); if (info) loadModel(info); });
  $("retry").addEventListener("click", discover);
  $("zoom").addEventListener("input", (event) => setZoom(event.target.value));
  $("zoom-in").addEventListener("click", () => setZoom(Number($("zoom").value) + 10));
  $("zoom-out").addEventListener("click", () => setZoom(Number($("zoom").value) - 10));
  $("reset").addEventListener("click", resetView);
  for (const tab of ["expressions", "motions"]) {
    $(`tab-${tab}`).addEventListener("click", () => setTab(tab));
    $(`tab-${tab}`).addEventListener("keydown", (event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const name = event.key === "Home" ? "expressions" : event.key === "End" ? "motions" : (tab === "expressions" ? "motions" : "expressions"); setTab(name); $(`tab-${name}`).focus(); } });
  }
  for (const key of ["tracking"]) {
    $(key).addEventListener("click", () => {
      const active = $(key).getAttribute("aria-checked") !== "true";
      $(key).setAttribute("aria-checked", String(active));
      if (key === "tracking") { state.follow = active; if (!active && state.model) state.model.internalModel.focusController.focus(0, 0); }
    });
  }
  $("breath-amplitude").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    state.breathAmplitude = value / 100;
    state.idle = value > 0;
    $("breath-amplitude-value").value = value + "%";
    applyBreathAmplitude();
  });
  $("relaxed-arms").addEventListener("click", () => {
    state.relaxedArms = !state.relaxedArms;
    $("relaxed-arms").setAttribute("aria-checked", String(state.relaxedArms));
  });
  for (const button of document.querySelectorAll("[data-bg]")) button.addEventListener("click", () => {
    $("stage").dataset.background = button.dataset.bg;
    for (const swatch of document.querySelectorAll("[data-bg]")) { swatch.classList.toggle("selected", swatch === button); swatch.setAttribute("aria-pressed", String(swatch === button)); }
  });
  let drag = null;
  $("stage").addEventListener("pointerdown", (event) => {
    if (event.target.closest("button") || !state.model || event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, offsetX: state.offset.x, offsetY: state.offset.y };
    $("stage").setPointerCapture(event.pointerId);
  });
  $("stage").addEventListener("pointermove", (event) => {
    if (!state.model) return;
    if (drag) { state.offset = { x: drag.offsetX + event.clientX - drag.x, y: drag.offsetY + event.clientY - drag.y }; fit(); }
    else if (state.follow) { state.model.focus(event.clientX, event.clientY); }
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) $("stage").addEventListener(event, () => { drag = null; });
  $("stage").addEventListener("pointerleave", () => { if (state.model && !drag) state.model.internalModel.focusController.focus(0, 0); });
  $("stage").addEventListener("wheel", (event) => { if (!state.model) return; event.preventDefault(); setZoom(Number($("zoom").value) + (event.deltaY < 0 ? 5 : -5)); }, { passive: false });
  $("capture").addEventListener("click", () => {
    if (!state.app || !state.model) return;
    try {
      state.app.renderer.render(state.app.stage);
      $("live2d").toBlob((blob) => {
        if (!blob) return toast("截图失败，请重试。");
        const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `${state.current.name}-${Date.now()}.png`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast("截图已保存，背景是透明的。");
      }, "image/png");
    } catch { toast("截图失败，请检查浏览器支持。"); }
  });
  $("fullscreen").addEventListener("click", async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector(".stage-card").requestFullscreen(); }
    catch { toast("当前浏览器暂不支持全屏。"); }
  });
  new ResizeObserver(() => fit()).observe($("stage"));
  $("nav-chat").addEventListener("click", () => { $("chat").scrollIntoView({ behavior: "smooth", block: "center" }); $("chat-input").focus({ preventScroll: true }); });
  $("nav-controls").addEventListener("click", () => { $("controls").scrollIntoView({ behavior: "smooth", block: "center" }); $("tab-expressions").focus({ preventScroll: true }); });
  $("nav-studio").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  $("about").addEventListener("click", () => $("about-dialog").showModal());
  $("close-about").addEventListener("click", () => $("about-dialog").close());
  $("live2d").addEventListener("webglcontextlost", (event) => { event.preventDefault(); toast("图形连接已中断，请刷新页面重新加载模型。"); });
  document.addEventListener("visibilitychange", () => { if (state.app) document.hidden ? state.app.stop() : state.app.start(); });
  discover();
})();
