"use strict";

let catalog = [];
let instrumentSimulatedLocked = false;

function activeAssay() {return catalog.find((item) => item.id === state.assayId);}

function selectAssay(identifier) {
  const assay = catalog.find((item) => item.id === identifier);
  if (!assay) return;
  const changed = state.assayId !== identifier;
  state.assayId = identifier;
  state.path = assay.preferred_path;
  byId("assay-select").value = identifier;
  byId("instrument-wavelength").value = assay.wavelength || 450;
  if (changed) {
    state.instrumentResult = null;
    byId("instrument-csv").value = "";
    byId("instrument-reference-wavelength").value = "";
    byId("instrument-unit").value = "";
    byId("instrument-subtract").checked = false;
    byId("instrument-simulated").checked = false;
    instrumentSimulatedLocked = false;
    byId("instrument-filename").textContent = "也可在下方直接粘贴数据";
    byId("instrument-source-badge").textContent = "等待导入";
    invalidate("实验方法已切换，请重新分析。");
    byId("shared-experiment-name").value = assay.name;
    byId("experiment-name").value = assay.name;
  }
  byId("method-description").innerHTML = `<div class="method-principle"><span class="method-category">${escapeHtml(assay.category)}</span><strong>${escapeHtml(assay.principle)}</strong><span>${assay.id === "qpcr" ? "Ct / ΔCt · 不使用吸光度" : assay.wavelength ? `${assay.wavelength} nm · 参考产品读数` : "照片观察 · 不输出浓度"}</span></div><p>${escapeHtml(assay.note)}</p><div class="method-reference"><a href="${escapeHtml(assay.source_url)}" target="_blank" rel="noopener noreferrer">查看方法来源 ↗</a><span>${escapeHtml(assay.reference)}</span></div><small>${escapeHtml(assay.validation)}。实际厂家、货号、物种与批次请在“实验信息与追溯”填写。</small>`;
  byId("method-path-note").textContent = assay.id === "qpcr" ? "qPCR 有快捷和批量两种输入；计算表达量，不使用 OD / 波长字段。" : assay.photo_allowed ? "照片数值只描述颜色；模拟试管图不代表所选方法的真实显色。" : "此方法走仪器读数流程，照片不能替代吸光度。";
  document.querySelectorAll("[data-assay]").forEach((button) => {button.classList.toggle("selected", button.dataset.assay === identifier);});
  renderPath();
  renderInstrument();
}

function renderPath() {
  const assay = activeAssay();
  byId("photo-workspace").hidden = state.path !== "photo";
  byId("instrument-workspace").hidden = state.path !== "instrument" || state.assayId === "qpcr";
  if (byId("qpcr-workspace")) byId("qpcr-workspace").hidden = state.path !== "instrument" || state.assayId !== "qpcr";
  window.ColorLensQpcr?.sync();
  window.ColorLensElisa?.sync();
  byId("path-photo").disabled = state.busy || !assay?.photo_allowed;
  byId("path-instrument").disabled = state.busy || !assay?.instrument_allowed;
  byId("path-photo").classList.toggle("primary", state.path === "photo");
  byId("path-instrument").classList.toggle("primary", state.path === "instrument");
  byId("path-photo").classList.toggle("secondary", state.path !== "photo");
  byId("path-instrument").classList.toggle("secondary", state.path !== "instrument");
  byId("instrument-simulated").disabled = state.busy || instrumentSimulatedLocked;
  if (state.path === "instrument") byId("import-kind").disabled = true;
}

function instrumentPayload() {
  return {assay_id: state.assayId, csv: byId("instrument-csv").value, wavelength: Number(byId("instrument-wavelength").value), reference_wavelength: byId("instrument-reference-wavelength").value || null, unit: byId("instrument-unit").value.trim(), subtract_blank: byId("instrument-subtract").checked, simulated: byId("instrument-simulated").checked, filename: state.instrumentFilename || "pasted.csv", experiment: experiment(), mode: state.mode, ...window.ColorLensNotebook?.analysisLink()};
}

function invalidateInstrument() {
  state.instrumentResult = null;
  renderInstrument();
}

function renderInstrument() {
  if (window.ColorLensElisa?.active()) return;
  if (state.assayId === "qpcr") {window.ColorLensQpcr?.sync(); return;}
  const result = state.instrumentResult;
  if (!result) {
    byId("instrument-result").innerHTML = '<div class="empty-result">导入仪器 CSV，或载入明确标记的模拟读数体验流程。<br><span style="font-size:10px">仅做读数整理与质控，本版未启用浓度换算。</span></div>';
    return;
  }
  byId("instrument-source-badge").textContent = result.simulated ? "模拟读数" : "用户仪器读数";
  const roles = {blank: "空白", standard: "标准品", sample: "样本", control: "对照"};
  const groups = result.groups.map((group) => `<tr><td>${escapeHtml(group.sample_id)}</td><td>${roles[group.role]}</td><td>${group.n}</td><td>${number(group.mean_od, 4)}</td><td>${number(group.sd, 4)}</td><td>${number(group.cv_percent, 2)}</td><td>${group.standard_concentration === null ? "—" : escapeHtml(group.standard_concentration)}</td><td>${group.warnings.length ? group.warnings.map(escapeHtml).join("；") : "未触发当前提示"}</td></tr>`).join("");
  const standards = result.groups.filter((group) => group.role === "standard").sort((first, second) => first.standard_concentration - second.standard_concentration);
  let chart = "";
  if (standards.length) {
    const minimum = Math.min(0, ...standards.map((group) => group.mean_od));
    const maximum = Math.max(0.01, ...standards.map((group) => group.mean_od));
    const bars = standards.map((group) => `<div class="bar-row"><span class="bar-name">${escapeHtml(group.standard_concentration)} ${escapeHtml(byId("instrument-unit").value)}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${Math.max(0, (group.mean_od - minimum) / (maximum - minimum) * 100)}%"></span></span><span class="bar-value">${number(group.mean_od, 3)}</span></div>`).join("");
    chart = `<div class="instrument-chart"><div class="chart-title">已知标准品的读数分布<span>未拟合曲线 · 不估计未知浓度</span></div>${bars}<div class="chart-axis">纵轴：用户输入标准品浓度与单位 · 横轴：处理后 OD（无量纲），范围 ${number(minimum, 3)}–${number(maximum, 3)}</div><p>来源：当前导入 CSV 的当前批次。标准品浓度为已知输入；${result.simulated ? "本图是程序构造的模拟读数。" : "未验证该批次校准关系。"}</p></div>`;
  }
  byId("instrument-result").innerHTML = `<div class="instrument-summary"><span><strong>${result.rows.length}</strong> 条读数</span><span><strong>${result.groups.length}</strong> 个样本组</span><span>主波长 <strong>${result.wavelength}</strong> nm</span><span>空白扣除 <strong>${result.subtract_blank ? "已执行一次" : "未执行"}</strong></span></div><div class="instrument-warnings">${result.warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("")}</div><div class="table-scroll"><table><thead><tr><th>样本</th><th>角色</th><th>孔数 n</th><th>平均 OD</th><th>样本 SD</th><th>CV %</th><th>已知标准浓度</th><th>检查提示</th></tr></thead><tbody>${groups}</tbody></table></div>${chart}`;
}

async function loadInstrumentDemo() {
  if (state.busy) return;
  setBusy(true, "载入模拟读数…");
  try {
    const data = await api("/api/instrument/demo", {assay_id: state.assayId});
    byId("instrument-csv").value = data.csv;
    byId("instrument-wavelength").value = data.wavelength;
    byId("instrument-unit").value = "模拟单位";
    byId("instrument-simulated").checked = true;
    instrumentSimulatedLocked = true;
    state.instrumentFilename = data.filename;
    byId("instrument-filename").textContent = data.filename;
    state.instrumentResult = await api("/api/instrument/analyze", instrumentPayload());
    renderInstrument();
    toast(data.note);
  } catch (error) {toast(error.message, true);}
  finally {setBusy(false);}
}

async function runInstrument() {
  if (state.busy) return;
  setBusy(true, "整理仪器读数…");
  try {
    state.instrumentResult = await api("/api/instrument/analyze", instrumentPayload());
    if (state.instrumentResult.simulated) instrumentSimulatedLocked = true;
    renderInstrument();
    toast("读数与重复孔统计已整理；未执行浓度换算。");
  } catch (error) {toast(error.message, true);}
  finally {setBusy(false);}
}

async function exportInstrument() {
  if (window.ColorLensElisa?.active()) return window.ColorLensElisa.save();
  if (state.assayId === "qpcr") return window.ColorLensQpcr.save();
  if (state.busy) return;
  if (!state.instrumentResult) return toast("请先整理当前仪器读数，再保存。", true);
  try {await window.ColorLensNotebook?.prepareAnalysis();} catch (error) {return toast(error.message, true);}
  setBusy(true, "保存仪器记录…");
  try {
    const saved = await api("/api/instrument/export", instrumentPayload());
    await window.ColorLensNotebook?.analysisSaved(saved);
    byId("saved-path").value = saved.path;
    byId("download-link").href = saved.download_url;
    byId("export-note").textContent = "已保存 CSV 文本副本、逐孔处理值、重复孔统计、方法来源、实验信息和 SHA-256 清单。" + (saved.simulated ? " 此记录标记为模拟数据。" : "");
    document.querySelector("#export-dialog>p").textContent = "仪器读数、处理选项与实验方法已关联保存。";
    document.querySelector("#export-dialog .export-file-list").innerHTML = "<span>导入 CSV 文本</span><span>逐孔处理 CSV</span><span>重复孔统计 CSV</span><span>完整 JSON</span><span>SHA-256 清单</span>";
    byId("export-dialog").showModal();
  } catch (error) {toast(error.message, true);}
  finally {setBusy(false);}
}

async function restoreInstrument(record) {
  selectAssay(record.instrument_input.assay_id);
  if (record.instrument_input.assay_id === "qpcr") return window.ColorLensQpcr.restore(record);
  if (record.result.measurement === "elisa") return window.ColorLensElisa.restore(record);
  if (byId("elisa-mode")) byId("elisa-mode").value = "od";
  renderPath();
  const inputs = record.instrument_input;
  byId("instrument-csv").value = inputs.csv;
  byId("instrument-wavelength").value = inputs.wavelength;
  byId("instrument-reference-wavelength").value = inputs.reference_wavelength || "";
  byId("instrument-unit").value = inputs.unit || "";
  byId("instrument-subtract").checked = Boolean(inputs.subtract_blank);
  byId("instrument-simulated").checked = Boolean(inputs.simulated);
  instrumentSimulatedLocked = Boolean(inputs.simulated);
  for (const [key, value] of Object.entries(record.experiment)) {
    const element = byId(`experiment-${key.replaceAll("_", "-")}`);
    if (element) element.value = value;
  }
  byId("shared-experiment-name").value = record.experiment.name || "";
  state.instrumentFilename = inputs.filename;
  state.instrumentResult = await api("/api/instrument/analyze", instrumentPayload());
  renderInstrument();
}

byId("assay-select").onchange = () => selectAssay(byId("assay-select").value);
byId("path-photo").onclick = () => {state.path = "photo"; renderPath(); drawCanvas();};
byId("path-instrument").onclick = () => {state.path = "instrument"; renderPath();};
byId("instrument-demo").onclick = loadInstrumentDemo;
byId("instrument-analyze").onclick = runInstrument;
byId("instrument-import").onclick = () => byId("instrument-file").click();
byId("instrument-file").onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 2_000_000) return toast("请选择 2 MB 以内的 CSV。", true);
  byId("instrument-csv").value = await file.text();
  byId("instrument-unit").value = "";
  state.instrumentFilename = file.name;
  byId("instrument-filename").textContent = file.name;
  instrumentSimulatedLocked = false;
  byId("instrument-simulated").checked = false;
  byId("instrument-source-badge").textContent = "用户导入 · 请确认数据类型";
  renderPath();
  invalidateInstrument();
  event.target.value = "";
};
byId("instrument-template").onclick = () => {
  const text = "\ufeffsample_id,role,well,od,reference_od,standard_concentration\nBlank,blank,A1,0.08,,\nSample-A,sample,A2,0.42,,\nSample-A,sample,A3,0.435,,\nSTD-1,standard,B1,0.6,,25\n";
  const url = URL.createObjectURL(new Blob([text], {type: "text/csv;charset=utf-8"}));
  const link = document.createElement("a"); link.href = url; link.download = "SIMULATED-CSV-format-example.csv"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("格式示例中的数值均为模拟数字；请替换为实际仪器读数。");
};
for (const identifier of ["instrument-csv", "instrument-wavelength", "instrument-reference-wavelength", "instrument-unit", "instrument-subtract", "instrument-simulated"]) byId(identifier).addEventListener("input", invalidateInstrument);
byId("shared-experiment-name").oninput = () => {byId("experiment-name").value = byId("shared-experiment-name").value;};
byId("experiment-name").addEventListener("input", () => {byId("shared-experiment-name").value = byId("experiment-name").value;});
function loadInstrumentAttachment(text, filename, simulated, assayId) {
  selectAssay(assayId);
  if (assayId === "qpcr") {window.ColorLensQpcr.loadCsv(text, filename, simulated); return;}
  if (window.ColorLensElisa?.active()) {window.ColorLensElisa.loadCsv(text, filename, simulated); return;}
  byId("instrument-csv").value = text;
  state.instrumentFilename = filename;
  byId("instrument-filename").textContent = filename + " · 来自实验原始附件";
  byId("instrument-simulated").checked = simulated;
  instrumentSimulatedLocked = simulated;
  byId("instrument-source-badge").textContent = simulated ? "模拟读数" : "用户原始附件";
  invalidateInstrument();
  renderPath();
}

window.ColorLensMethods = {selectAssay, renderPath, exportInstrument, restoreInstrument, loadInstrumentAttachment};
window.ColorLensCatalogReady = api("/api/assays").then((data) => {
  catalog = data.assays;
  const categories = [...new Set(catalog.map((assay) => assay.category))];
  byId("assay-select").innerHTML = categories.map((category) => `<optgroup label="${escapeHtml(category)}">${catalog.filter((assay) => assay.category === category).map((assay) => `<option value="${assay.id}">${escapeHtml(assay.name)}</option>`).join("")}</optgroup>`).join("");
  byId("method-shortcuts").innerHTML = ["qpcr", "il6", "il10", "tnfa", "bca", "sdh", "iodine"].map((identifier) => `<button data-assay="${identifier}" class="method-chip">${escapeHtml(catalog.find((assay) => assay.id === identifier).name)}</button>`).join("");
  byId("method-shortcuts").onclick = (event) => {const button = event.target.closest("[data-assay]"); if (button && !state.busy) selectAssay(button.dataset.assay);};
  selectAssay(state.assayId);
}).catch((error) => toast(error.message, true));
