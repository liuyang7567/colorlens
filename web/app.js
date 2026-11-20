"use strict";

const byId = (identifier) => document.getElementById(identifier);
const state = {asset: null, image: null, rois: [], control: null, selected: null, nextId: 1, result: null, mode: "teaching", tab: "overview", tool: "select", zoom: 1, busy: false, draft: null, savedId: null, assayId: "generic", path: "photo", instrumentResult: null, instrumentFilename: ""};
const canvas = byId("specimen-canvas");
const context = canvas.getContext("2d");
const colors = {green: "#3f7659", selected: "#eef5c3", caution: "#ba8d4a"};
const number = (value, digits = 2) => value === null || value === undefined ? "—" : Number(value).toFixed(digits);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
const rgbCss = (rgb) => rgb ? `rgb(${rgb.map((value) => Math.round(value)).join(",")})` : "#e1e7d9";
const statuses = {ok: "可用", caution: "需复核", invalid: "不可用"};
let toastTimer;

function toast(message, error = false) {
  const element = byId("toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {element.hidden = true;}, error ? 8000 : 4500);
}

async function api(path, payload) {
  await window.ColorLensCloud.ready;
  return window.ColorLensCloud.api(path, payload);
}

function setBusy(busy, message = "正在分析…") {
  state.busy = busy;
  document.querySelectorAll("#analysis-view button:not(.close-dialog)").forEach((button) => {button.disabled = busy;});
  document.querySelectorAll("#analysis-view input,#analysis-view select,#analysis-view textarea").forEach((element) => {element.disabled = busy;});
  byId("import-kind").disabled = busy || Boolean(state.asset?.simulated);
  byId("analyze-button").querySelector("span").textContent = busy ? message : "开始分析";
  byId("analysis-status").textContent = busy ? "正在本机计算，请稍候" : "同图相对比较 · RGB / Lab / ΔE₀₀";
  window.ColorLensMethods?.renderPath();
}

function parameters() {
  return {inset: Number(byId("inset-range").value) / 100, min_pixels: Number(byId("minimum-pixels").value), clip_warning: Number(byId("clipping-threshold").value) / 100};
}

function experiment() {
  const data = {name: (state.path === "instrument" ? byId("shared-experiment-name").value : byId("experiment-name").value).trim() || "未命名实验", date: byId("experiment-date").value, operator: byId("experiment-operator").value, device: byId("experiment-device").value, lighting: byId("experiment-lighting").value, reaction_time: byId("experiment-reaction-time").value, notes: byId("experiment-notes").value};
  for (const key of ["manufacturer", "catalog_number", "species", "lot", "protocol_version"]) data[key] = byId(`experiment-${key.replaceAll("_", "-")}`).value;
  return data;
}

function payload() {
  if (!state.asset) throw new Error("请先导入照片。");
  if (!state.rois.length) throw new Error("请先框选至少一个测量区域。");
  return {image_id: state.asset.image_id, rois: state.rois, control_id: state.control, parameters: parameters(), mode: state.mode, experiment: experiment(), assay_id: state.assayId, ...window.ColorLensNotebook?.analysisLink()};
}

function invalidate(message = "区域或参数已修改，请重新分析。") {
  state.result = null;
  state.savedId = null;
  byId("analysis-status").textContent = message;
  renderMetrics();
  renderResults();
  renderRois();
  drawCanvas();
}

function setMode(mode) {
  state.mode = mode;
  for (const item of ["teaching", "research"]) {
    byId(`mode-${item}`).classList.toggle("selected", item === mode);
    byId(`mode-${item}`).setAttribute("aria-pressed", String(item === mode));
  }
  byId("research-parameters").hidden = mode !== "research";
  byId("research-parameters").open = mode === "research";
  if (mode === "research") byId("experiment-details").open = true;
  renderResults();
}

function setTool(tool) {
  state.tool = tool;
  byId("tool-select").classList.toggle("active", tool === "select");
  byId("tool-draw").classList.toggle("active", tool === "draw");
  canvas.classList.toggle("select-mode", tool === "select");
}

function updateZoom(value) {
  state.zoom = Math.max(1, Math.min(4, value));
  canvas.style.width = `${state.zoom * 100}%`;
  byId("zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
  drawCanvas();
}

async function loadAsset(data) {
  if (data.assay_id) window.ColorLensMethods?.selectAssay(data.assay_id);
  state.asset = data;
  state.rois = data.rois || [];
  state.control = data.control_id || null;
  state.selected = state.rois[0]?.id || null;
  state.nextId = Math.max(0, ...state.rois.map((roi) => Number(roi.id.replace(/^R/, "")) || 0)) + 1;
  state.result = null;
  state.savedId = null;
  if (data.parameters) {
    byId("inset-range").value = data.parameters.inset * 100;
    byId("minimum-pixels").value = data.parameters.min_pixels;
    byId("clipping-threshold").value = data.parameters.clip_warning * 100;
  }
  byId("inset-label").textContent = `${byId("inset-range").value}%`;
  if (data.experiment) {
    for (const [key, value] of Object.entries(data.experiment)) {
      const element = byId(`experiment-${key.replaceAll("_", "-")}`);
      if (element) element.value = value;
    }
  }
  if (data.mode) setMode(data.mode);
  byId("shared-experiment-name").value = byId("experiment-name").value;
  const image = new Image();
  image.src = data.image_url;
  await image.decode();
  state.image = image;
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  byId("stage-loading").hidden = true;
  byId("image-size").textContent = `${data.image.width} × ${data.image.height} px`;
  byId("image-filename").textContent = data.image.filename;
  byId("source-badge").textContent = data.simulated ? "模拟数据" : "原始照片";
  byId("source-badge").classList.toggle("neutral", !data.simulated);
  byId("import-kind").value = data.simulated ? "simulated" : "real";
  byId("import-kind").disabled = data.simulated;
  byId("demo-notice").classList.toggle("real", !data.simulated);
  byId("demo-notice").querySelector("span:nth-child(2)").innerHTML = data.simulated ? "<strong>正在查看模拟实验。</strong> 图片由程序生成，仅用于体验操作与验证软件流程，不能证明真实测量精度。" : "<strong>已导入实际照片。</strong> 按 sRGB 解释，未做设备校准。请检查照片光照、对焦及反光，只比较同一张图内的样本。";
  byId("image-provenance").textContent = `SHA-256: ${data.image.sha256} · 浏览器解码至 sRGB，可能与旧 Python 版的 ICC 处理不同 · 原始字节不修改 · 保存分析时才上传原件`;
  updateZoom(1);
  setTool(state.rois.length ? "select" : "draw");
  renderRois();
  renderEditor();
  renderMetrics();
  renderResults();
  drawCanvas();
}

async function demo() {
  if (state.busy) return;
  if (state.path === "instrument") window.ColorLensMethods?.selectAssay("generic");
  setBusy(true, "载入演示…");
  try {
    const data = await api("/api/demo", {});
    byId("experiment-name").value = "五组溶液显色对比";
    byId("experiment-device").value = "程序生成的模拟图像";
    byId("experiment-notes").value = "模拟数据，仅用于软件演示与流程验证。";
    await loadAsset(data);
    state.result = await api("/api/analyze", payload());
    renderAll();
  } catch (error) {toast(error.message, true);}
  finally {setBusy(false);}
}

async function importFile(file) {
  if (!file || state.busy) return;
  if (file.size > 20 * 1024 * 1024) return toast("联网试用版请选择 20 MB 以内的照片。", true);
  setBusy(true, "导入照片…");
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("读取文件失败，请重试。"));
      reader.readAsDataURL(file);
    });
    const simulated = byId("import-kind").value === "simulated" && !state.asset;
    const data = await api("/api/import", {filename: file.name, data: dataUrl.split(",")[1], simulated});
    byId("experiment-name").value = file.name.replace(/\.[^.]+$/, "");
    byId("experiment-device").value = "";
    byId("experiment-notes").value = "";
    await loadAsset(data);
    toast("照片已导入。请选择“框选区域”，拖拽框出液体中央。");
  } catch (error) {toast(error.message, true);}
  finally {byId("file-input").value = ""; setBusy(false);}
}

function drawCanvas() {
  if (!state.image) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(state.image, 0, 0);
  const ratio = canvas.width / (canvas.getBoundingClientRect().width || 800);
  const thickness = Math.max(2, ratio * 1.3);
  context.lineJoin = "round";
  for (const roi of state.rois) {
    const selected = state.selected === roi.id;
    const row = state.result?.results.find((item) => item.id === roi.id);
    const stroke = selected ? "#e1efbd" : row?.status === "invalid" ? "#b46d4f" : colors.green;
    context.strokeStyle = stroke;
    context.lineWidth = thickness * (selected ? 1.6 : 1);
    context.setLineDash([6 * ratio, 4 * ratio]);
    context.strokeRect(roi.x, roi.y, roi.w, roi.h);
    const inset = parameters().inset;
    context.setLineDash([]);
    context.lineWidth = thickness;
    context.strokeStyle = "#f4f7e6";
    context.strokeRect(roi.x + Math.floor(roi.w * inset), roi.y + Math.floor(roi.h * inset), roi.w - 2 * Math.floor(roi.w * inset), roi.h - 2 * Math.floor(roi.h * inset));
    if (selected) {
      for (const [x, y] of [[roi.x, roi.y], [roi.x + roi.w, roi.y], [roi.x, roi.y + roi.h], [roi.x + roi.w, roi.y + roi.h]]) {
        context.fillStyle = "#e8f0cd";
        context.fillRect(x - 2.5 * ratio, y - 2.5 * ratio, 5 * ratio, 5 * ratio);
      }
    }
    const label = `${roi.id} · ${roi.label}${state.control === roi.id ? " / 对照" : ""}`;
    context.font = `${Math.max(12, 10 * ratio)}px "Microsoft YaHei", sans-serif`;
    const width = context.measureText(label).width + 12 * ratio;
    const y = Math.max(0, roi.y - 25 * ratio);
    context.fillStyle = selected ? "#e8f0d2" : "#315b45";
    context.fillRect(roi.x - thickness / 2, y, width, 20 * ratio);
    context.fillStyle = selected ? "#3b5c36" : "#f0f5e8";
    context.fillText(label, roi.x + 6 * ratio, y + 13.5 * ratio);
  }
  if (state.draft) {
    const draft = state.draft;
    context.strokeStyle = "#f3f7cd";
    context.lineWidth = thickness * 1.5;
    context.setLineDash([6 * ratio, 4 * ratio]);
    context.fillStyle = "#f4f4c328";
    context.fillRect(draft.start.x, draft.start.y, draft.end.x - draft.start.x, draft.end.y - draft.start.y);
    context.strokeRect(draft.start.x, draft.start.y, draft.end.x - draft.start.x, draft.end.y - draft.start.y);
    context.setLineDash([]);
  }
}

function renderRois() {
  byId("roi-count").textContent = state.rois.length;
  byId("roi-list").innerHTML = state.rois.map((roi) => {
    const row = state.result?.results.find((item) => item.id === roi.id);
    return `<div class="roi-item${state.selected === roi.id ? " selected" : ""}" role="button" tabindex="0" data-roi="${escapeHtml(roi.id)}" aria-label="选择 ${escapeHtml(roi.label)}"><span class="roi-swatch" style="background:${rgbCss(row?.rgb)}"><span class="roi-id">${escapeHtml(roi.id)}</span></span><span><span class="roi-title">${escapeHtml(roi.label)}</span><span class="roi-subtitle" style="display:block">${roi.w} × ${roi.h} px</span></span>${roi.id === state.control ? '<span class="control-pill">对照</span>' : `<span class="sample-status ${row?.status || ""}" title="${statuses[row?.status] || "待分析"}"></span>`}</div>`;
  }).join("");
}

function renderEditor() {
  const roi = state.rois.find((item) => item.id === state.selected);
  byId("roi-editor").hidden = !roi;
  if (!roi) return;
  byId("editor-id").textContent = `${roi.id} · 区域编辑`;
  byId("roi-label").value = roi.label;
  for (const key of ["x", "y", "w", "h"]) byId(`roi-${key}`).value = roi[key];
  byId("set-control").textContent = state.control === roi.id ? "当前已设为对照组" : "设为对照组";
}

function renderMetrics() {
  byId("metric-count").textContent = state.rois.length;
  const result = state.result;
  byId("metric-pair").textContent = result?.closest ? result.closest.ids.join(" ↔ ") : "—";
  byId("metric-pair-note").textContent = result?.closest ? result.closest.labels.join(" / ") : "完成分析后显示最小色差";
  byId("metric-delta").textContent = number(result?.closest?.delta_e, 2);
  const valid = result?.results.filter((row) => row.status !== "invalid").length || 0;
  const cautions = result?.results.filter((row) => row.status === "caution").length || 0;
  const invalid = result ? result.results.length - valid : 0;
  byId("metric-quality").textContent = !result ? "待分析" : invalid ? `${invalid} 个不可用` : cautions ? "建议人工复核" : "全部区域可用";
  byId("metric-quality-note").textContent = !result ? "检查反光、像素数与颜色均匀度" : `${valid}/${result.results.length} 个区域可计算 · ${cautions} 个需注意`;
  byId("results-badge").textContent = result ? state.asset.simulated ? "模拟分析结果" : "计算已完成" : "待重新分析";
  byId("quality-count").textContent = result ? result.results.reduce((sum, row) => sum + row.warnings.length, 0) : "";
}

function renderResults() {
  const result = state.result;
  if (!result) {
    byId("result-content").innerHTML = '<div class="empty-result">选择测量区域并指定对照组后，点击“开始分析”。<br><span style="font-size:10px">区域或参数修改后，需要重新计算结果。</span></div>';
    return;
  }
  if (state.tab === "overview") {
    const maximum = Math.max(1, ...result.results.map((row) => row.delta_e || 0));
    const scaleMax = Math.ceil(maximum / 5) * 5;
    const bars = result.results.map((row) => `<div class="bar-row"><span class="bar-name" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span><span class="bar-track"><span class="bar-fill${row.id === state.control ? " control" : ""}" style="display:block;width:${row.delta_e === null ? 0 : row.delta_e / scaleMax * 100}%"></span></span><span class="bar-value">${number(row.delta_e)}</span></div>`).join("");
    const closest = result.closest;
    let closestCard = '<div class="closest-card"><div class="closest-title">有效区域不足</div><p class="closest-description">请增加至少两个可用区域，以比较两两色差。</p></div>';
    if (closest) {
      const first = result.results.find((row) => row.id === closest.ids[0]);
      const second = result.results.find((row) => row.id === closest.ids[1]);
      closestCard = `<div class="closest-card"><div class="closest-eyebrow">CLOSEST PAIR / 最接近的样本</div><div class="closest-title">${escapeHtml(closest.labels[0])}<span style="color:#b1bca5;margin:0 8px">↔</span>${escapeHtml(closest.labels[1])}</div><div class="pair-swatches"><span style="background:${rgbCss(first.rgb)}">${escapeHtml(first.id)}</span><span style="background:${rgbCss(second.rgb)}">${escapeHtml(second.id)}</span></div><div class="closest-reading">${number(closest.delta_e)}<small>ΔE₀₀ · 图像色差</small></div><p class="closest-description">这两个区域在当前图像中颜色最接近。色差大小需结合质量提示和实验条件理解，不直接表示实验效应。</p></div>`;
    }
    byId("result-content").innerHTML = `<div class="results-overview"><div><div class="chart-title">相对对照组的颜色差异<span>对照：${escapeHtml(result.results.find((row) => row.id === state.control)?.label || "—")}</span></div>${bars}<div class="chart-scale"><span>0</span><span>${number(scaleMax / 2, 0)}</span><span>${scaleMax}</span></div><div class="chart-axis">横轴：与对照的 ΔE₀₀（无量纲） · 纵轴：样本</div></div>${closestCard}</div>`;
  } else if (state.tab === "data") {
    const research = state.mode === "research";
    const rows = result.results.map((row) => `<tr><td><span class="table-swatch" style="background:${rgbCss(row.rgb)}"></span>${escapeHtml(row.label)}</td><td>${row.rgb ? row.rgb.map((value) => number(value, 1)).join(" / ") : "—"}</td>${research ? `<td>${row.hsv ? row.hsv.map((value) => number(value, 1)).join(" / ") : "—"}</td>` : ""}<td>${row.lab ? row.lab.map((value) => number(value, 2)).join(" / ") : "—"}</td><td>${number(row.delta_e)}</td>${research ? `<td>${row.pixels.toLocaleString()}</td><td>${number(row.spread)}</td><td>${number(row.clipped === null ? null : row.clipped * 100)}%</td>` : ""}<td><span class="status-pill ${row.status}">${statuses[row.status]}</span></td></tr>`).join("");
    byId("result-content").innerHTML = `<div class="table-scroll"><table><thead><tr><th>样本</th><th>RGB 中位色（0–255）</th>${research ? "<th>HSV（° / % / %）</th>" : ""}<th>Lab（L* / a* / b*）</th><th>ΔE₀₀ 对照差</th>${research ? "<th>有效像素</th><th>Lab 离散度</th><th>饱和像素</th>" : ""}<th>质量</th></tr></thead><tbody>${rows}</tbody></table></div><p class="table-note">采样方式：内缩 ${number(result.parameters.inset * 100, 0)}%，保留全部区域像素。RGB 各通道取中位数；HSV 由该 RGB 中位色计算；Lab 逐像素转换后分别取中位数。${research ? "Lab 离散度为像素到代表 Lab 的欧氏距离中位数，仅描述区域不均匀程度。" : "切换科研模式可查看 HSV、有效像素与离散度。"}</p>`;
  } else if (state.tab === "matrix") {
    const maximum = Math.max(1, ...result.matrix.flat().filter((value) => value !== null));
    const rows = result.results.map((row, index) => `<tr><th>${escapeHtml(row.label)}</th>${result.matrix[index].map((value) => `<td style="background:${value === null ? "#fafbf7" : `rgba(88,130,69,${0.035 + value / maximum * 0.22})`}">${number(value)}</td>`).join("")}</tr>`).join("");
    byId("result-content").innerHTML = `<div class="table-scroll"><table class="matrix-table"><thead><tr><th>ΔE₀₀</th>${result.results.map((row) => `<th>${escapeHtml(row.label)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div><p class="table-note">行与列为样本；单元格为两两 CIEDE2000 色差（无量纲）。色深表示差异更大，"—" 表示区域不可用。来源：当前图像当前区域，未做跨图校准。</p>`;
  } else {
    byId("result-content").innerHTML = `<div class="quality-list">${result.results.map((row) => `<div class="quality-row"><div><strong>${escapeHtml(row.label)}</strong><span class="status-pill ${row.status}">${statuses[row.status]}</span><small>${row.pixels.toLocaleString()} 个有效像素</small></div><div><p>${row.warnings.length ? row.warnings.map(escapeHtml).join("<br>") : "未触发当前默认质量阈值。仍需人工确认区域有效。"}</p>${state.mode === "research" ? `<small>通道饱和 ${number(row.clipped === null ? null : row.clipped * 100)}% · 暗部 ${number(row.dark === null ? null : row.dark * 100)}% · 纹理指标 ${number(row.sharpness)} · Lab 离散度 ${number(row.spread)}</small>` : ""}</div></div>`).join("")}</div><p class="table-note">质量规则是尚待真实照片验证的工程提示。均匀或浅色液体可能触发低纹理或高亮提示；不自动判定实验失败。</p>`;
  }
}

function renderAll() {renderRois(); renderEditor(); renderMetrics(); renderResults(); drawCanvas();}

function chooseRoi(identifier) {
  state.selected = identifier;
  renderRois();
  renderEditor();
  drawCanvas();
}

function addRoi(bounds) {
  if (state.rois.length >= 32) return toast("一个实验最多添加 32 个区域。", true);
  const identifier = `R${state.nextId++}`;
  const roi = {id: identifier, label: `样本 ${state.rois.length + 1}`, role: "sample", ...bounds};
  state.rois.push(roi);
  if (!state.control) {state.control = identifier; roi.role = "control"; roi.label = "对照组";}
  state.selected = identifier;
  invalidate();
  renderEditor();
  setTool("select");
}

function deleteRoi() {
  if (!state.selected || state.busy) return;
  state.rois = state.rois.filter((roi) => roi.id !== state.selected);
  if (state.control === state.selected) state.control = state.rois[0]?.id || null;
  state.rois.forEach((roi) => {roi.role = roi.id === state.control ? "control" : "sample";});
  state.selected = state.rois[0]?.id || null;
  invalidate();
  renderEditor();
}

function applyEditor() {
  const roi = state.rois.find((item) => item.id === state.selected);
  if (!roi) return;
  const values = {};
  for (const key of ["x", "y", "w", "h"]) {
    const input = byId(`roi-${key}`);
    if (input.value === "" || !Number.isInteger(Number(input.value))) return toast("区域坐标必须是整数。", true);
    values[key] = Number(input.value);
  }
  if (values.x < 0 || values.y < 0 || values.w < 1 || values.h < 1 || values.x + values.w > canvas.width || values.y + values.h > canvas.height) return toast("区域超出图片或尺寸无效，请修改坐标。", true);
  Object.assign(roi, values, {label: byId("roi-label").value.trim() || roi.id});
  invalidate();
  renderEditor();
}

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return {x: Math.max(0, Math.min(canvas.width, Math.round((event.clientX - rect.left) / rect.width * canvas.width))), y: Math.max(0, Math.min(canvas.height, Math.round((event.clientY - rect.top) / rect.height * canvas.height)))};
}

canvas.addEventListener("pointerdown", (event) => {
  if (state.busy || !state.image || event.button !== 0) return;
  const point = pointerPosition(event);
  if (state.tool === "select") {
    const roi = [...state.rois].reverse().find((item) => point.x >= item.x && point.x <= item.x + item.w && point.y >= item.y && point.y <= item.y + item.h);
    if (roi) chooseRoi(roi.id);
    return;
  }
  canvas.setPointerCapture(event.pointerId);
  state.draft = {start: point, end: point};
  drawCanvas();
});
canvas.addEventListener("pointermove", (event) => {
  if (!state.draft) return;
  state.draft.end = pointerPosition(event);
  drawCanvas();
});
canvas.addEventListener("pointerup", (event) => {
  if (!state.draft) return;
  const {start, end} = {...state.draft, end: pointerPosition(event)};
  state.draft = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  const bounds = {x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y)};
  if (bounds.w >= 4 && bounds.h >= 4) addRoi(bounds);
  else {drawCanvas(); toast("区域过小，请拖拽一个更大的矩形。", true);}
});
canvas.addEventListener("pointercancel", () => {state.draft = null; drawCanvas();});

byId("roi-list").addEventListener("click", (event) => {
  const item = event.target.closest("[data-roi]");
  if (item && !state.busy) chooseRoi(item.dataset.roi);
});
byId("roi-list").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {event.preventDefault(); event.target.closest("[data-roi]")?.click();}
});
byId("add-roi").onclick = () => {
  if (!state.image) return toast("请先导入照片。", true);
  const width = Math.max(10, Math.round(canvas.width * .09));
  const height = Math.max(10, Math.round(canvas.height * .2));
  addRoi({x: Math.round((canvas.width - width) / 2), y: Math.round((canvas.height - height) / 2), w: width, h: height});
  toast("已添加中央区域。可拖框重建，或用坐标调整位置与大小。");
};
byId("update-roi").onclick = applyEditor;
byId("roi-label").addEventListener("keydown", (event) => {if (event.key === "Enter") applyEditor();});
byId("delete-roi").onclick = deleteRoi;
byId("set-control").onclick = () => {
  state.control = state.selected;
  state.rois.forEach((roi) => {roi.role = roi.id === state.control ? "control" : "sample";});
  invalidate(); renderEditor();
};
byId("tool-select").onclick = () => setTool("select");
byId("tool-draw").onclick = () => {setTool("draw"); toast("在照片上按住并拖拽，框出有效液体区域。");};
byId("zoom-in").onclick = () => updateZoom(state.zoom + .25);
byId("zoom-out").onclick = () => updateZoom(state.zoom - .25);
byId("zoom-fit").onclick = () => updateZoom(1);
byId("inset-range").oninput = () => {byId("inset-label").textContent = `${byId("inset-range").value}%`; invalidate();};
byId("minimum-pixels").onchange = () => invalidate();
byId("clipping-threshold").onchange = () => invalidate();
byId("import-kind").onchange = async () => {
  if (!state.asset || byId("import-kind").value !== "simulated") return;
  try {
    await api("/api/mark-simulated", {image_id: state.asset.image_id});
    state.asset.simulated = true;
    byId("import-kind").disabled = true;
    byId("source-badge").textContent = "模拟数据";
    byId("demo-notice").classList.remove("real");
    byId("demo-notice").querySelector("span:nth-child(2)").innerHTML = "<strong>已将此图标记为模拟数据。</strong> 此标识会保留在界面与导出记录中，不能作为真实测量精度验证。";
    invalidate("数据类型已标记为模拟，请重新分析。");
  } catch (error) {toast(error.message, true);}
};
byId("mode-teaching").onclick = () => setMode("teaching");
byId("mode-research").onclick = () => setMode("research");
byId("file-input").onchange = (event) => importFile(event.target.files[0]);
for (const identifier of ["import-button", "notice-import"]) byId(identifier).onclick = () => byId("file-input").click();
for (const identifier of ["load-demo", "sidebar-demo"]) byId(identifier).onclick = demo;
byId("analyze-button").onclick = async () => {
  if (state.busy) return;
  try {
    const request = payload();
    setBusy(true);
    state.result = await api("/api/analyze", request);
    renderAll();
    toast("分析完成。请结合质量检查理解颜色差异。");
  } catch (error) {toast(error.message, true);}
  finally {setBusy(false);}
};
document.querySelectorAll("[data-tab]").forEach((button) => {
  button.onclick = () => {
    state.tab = button.dataset.tab;
    document.querySelectorAll("[data-tab]").forEach((item) => {item.classList.toggle("active", item === button); item.setAttribute("aria-selected", String(item === button));});
    renderResults();
  };
});

byId("export-top").onclick = async () => {
  if (state.busy) return;
  if (state.path === "instrument") return window.ColorLensMethods.exportInstrument();
  if (!state.result) return toast("请先完成当前区域的分析，再保存结果。", true);
  try {await window.ColorLensNotebook?.prepareAnalysis();} catch (error) {return toast(error.message, true);}
  setBusy(true, "保存记录…");
  try {
    const saved = await api("/api/export", payload());
    await window.ColorLensNotebook?.analysisSaved(saved);
    state.savedId = saved.id;
    byId("saved-path").value = saved.path;
    byId("download-link").href = saved.download_url;
    byId("export-note").textContent = saved.simulated ? "此记录保留“模拟数据”标识，仅用于软件流程演示。" : "记录已保存到你的私有云端空间。建议下载完整 ZIP，并在另一块磁盘保存备份。";
    document.querySelector("#export-dialog>p").textContent = "原图、测量区域、实验方法与分析结果已关联保存。";
    document.querySelector("#export-dialog .export-file-list").innerHTML = "<span>原始照片</span><span>标注图 PNG</span><span>结果 CSV</span><span>色差矩阵 CSV</span><span>完整 JSON</span><span>SHA-256 清单</span>";
    byId("export-dialog").showModal();
  } catch (error) {toast(error.message, true);}
  finally {setBusy(false);}
};

byId("nav-archive").onclick = async () => {
  try {
    const records = await api("/api/records");
    byId("records-list").innerHTML = records.length ? records.map((record) => `<div class="record-row"><div class="record-main"><strong>${escapeHtml(record.name || "未命名实验")} ${record.simulated ? '<span class="badge">模拟数据</span>' : ""}</strong><small>${escapeHtml(record.id)}${record.valid ? ` · ${record.roi_count} ${record.analysis_type === "instrument" ? "条仪器读数" : "个区域"}` : " · 校验失败，请检查本地文件"}</small></div>${record.valid ? `<button class="button secondary restore-record" data-record="${escapeHtml(record.id)}">在线查看</button><a class="button secondary" href="/api/download/${escapeHtml(record.id)}" download>下载 ZIP（可选）</a>` : ""}</div>`).join("") : '<div class="empty-result">还没有保存的实验记录。<br>完成分析后，点击“保存与导出”。</div>';
  } catch (error) {toast(error.message, true);}
};
byId("records-list").addEventListener("click", async (event) => {
  const button = event.target.closest(".restore-record");
  if (!button || state.busy) return;
  setBusy(true, "打开记录…");
  try {
    await window.ColorLensNotebook.openPage("snapshot", button.dataset.record);
  } catch (error) {toast(error.message, true);}
  finally {setBusy(false);}
});
byId("nav-workbench").onclick = () => window.scrollTo({top: 0, behavior: "smooth"});
document.querySelectorAll(".close-dialog").forEach((button) => {button.onclick = () => button.closest("dialog").close();});
document.querySelectorAll("dialog").forEach((dialog) => {dialog.addEventListener("click", (event) => {if (event.target === dialog) {const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();}});});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {state.draft = null; drawCanvas();}
  if (event.key === "Delete" && !event.target.closest("input,textarea,select,dialog,[contenteditable]")) deleteRoi();
});
byId("image-stage").addEventListener("dragover", (event) => {event.preventDefault();});
byId("image-stage").addEventListener("drop", (event) => {event.preventDefault(); importFile(event.dataTransfer.files[0]);});
window.addEventListener("resize", drawCanvas);
byId("runtime-label").textContent = window.COLORLENS.runtime === "desktop" ? "WINDOWS" : "WEB";
byId("experiment-date").value = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
setMode("teaching");
window.ColorLensDemoReady = demo();
