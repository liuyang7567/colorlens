"use strict";

(() => {
  const notes = {entry: null, dirty: false, generation: 0, saving: null, timer: null, working: false, status: "", offset: 0, total: 0, historyOffset: 0, historyTotal: 0, listRequest: 0, analysisOwner: null, attachment: null, bodyFormat: null, bodyCursor: null};
  const fields = ["title", "date", "operator", "project", "kind", "template", "body", "purpose", "materials", "procedure", "results", "discussion"];
  const kinds = {course: "课程实验", research: "课题研究", general: "其他实验"};
  let routing = false;
  let currentRoute = "notebook";
  const run = (operation) => Promise.resolve().then(operation).catch((error) => toast(error.message, true));
  const localDate = () => new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
  const stamp = (value) => Number.isNaN(Date.parse(value)) ? String(value) : new Date(value).toLocaleString("sv-SE", {timeZone: "Asia/Shanghai", hour12: false});
  const writable = () => notes.entry && !notes.entry.deleted && notes.entry.data.status === "draft";

  function setRoute(route) {
    currentRoute = route;
    if (location.hash === "#" + route) return;
    window.history[routing ? "replaceState" : "pushState"](null, "", "#" + route);
  }

  function readForm() {
    const data = Object.fromEntries(fields.map((key) => [key, byId(`note-${key}`).value]));
    data.body = bodyContent();
    Object.assign(data, window.ColorLensTemplates.readNote(notes.entry));
    if (notes.bodyFormat) data.body_format = notes.bodyFormat;
    data.tags = byId("note-tags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    data.status = notes.entry?.data.status || "draft";
    data.event_draft = byId("note-event-text").value;
    return data;
  }

  function bodyContent() {
    return [...byId("note-rich-body").children].map((element) => element.matches("textarea") ? element.value : `[[colorlens-image:${element.dataset.inlineImage}]]`).join("");
  }

  function growBodyText(element) {
    element.style.height = "auto";
    const minimum = byId("note-rich-body").classList.contains("has-images") ? 60 : 260;
    element.style.height = `${Math.max(minimum, element.scrollHeight)}px`;
  }

  function rememberBodyCursor(event) {
    const element = event.target;
    if (element.matches(".note-body-text")) notes.bodyCursor = {element, position: element.selectionStart};
  }

  function bodyText(text, first = false) {
    const element = document.createElement("textarea");
    element.className = "note-body-text";
    if (first) element.id = "note-body";
    element.rows = 2;
    element.maxLength = 100000;
    element.value = text;
    element.placeholder = first ? "写下实验计划与观察，可在文字中插入图片…" : "在图片后继续记录…";
    element.setAttribute("aria-label", first ? "实验笔记正文" : "图片后的正文文字");
    element.disabled = !writable() || notes.working;
    return element;
  }

  function bodyImage(attachmentId) {
    const attachment = notes.entry.attachments.find((item) => item.id === attachmentId);
    const figure = document.createElement("figure");
    figure.className = "note-inline-image";
    figure.dataset.inlineImage = attachmentId;
    const image = document.createElement("img");
    image.src = "/api/notebook/preview/" + attachmentId;
    image.alt = attachment?.filename || "正文图片";
    image.loading = "lazy";
    const caption = document.createElement("figcaption");
    const name = document.createElement("span");
    name.textContent = attachment?.filename || "图片附件不可用，请检查原始资料";
    const actions = document.createElement("span");
    const download = document.createElement("a");
    download.href = "/api/notebook/attachment/" + attachmentId;
    download.download = "";
    download.textContent = "下载原图";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.dataset.removeInline = attachmentId;
    remove.textContent = "移出正文";
    remove.disabled = !writable() || notes.working;
    image.addEventListener("error", () => {name.textContent = "图片预览失败，请检查原始附件或备份。";});
    actions.append(download, remove);
    caption.append(name, actions);
    figure.append(image, caption);
    return figure;
  }

  function renderBody() {
    const root = byId("note-rich-body");
    const data = notes.entry.data;
    notes.bodyFormat = data.body_format || null;
    notes.bodyCursor = null;
    const parts = notes.bodyFormat ? data.body.split(/\[\[colorlens-image:([0-9a-f]{32})\]\]/g) : [data.body];
    root.replaceChildren(...parts.map((part, index) => index % 2 ? bodyImage(part) : bodyText(part, index === 0)));
    root.classList.toggle("has-images", parts.length > 1);
    requestAnimationFrame(() => root.querySelectorAll("textarea").forEach(growBodyText));
  }

  function insertBodyImage(attachmentId, dirty = true) {
    if (!writable() || dirty && notes.working) throw new Error("记录只读或正在保存，请先恢复编辑。");
    const root = byId("note-rich-body");
    if (root.querySelectorAll("figure").length >= 50) throw new Error("每条正文最多插入 50 张图片。");
    const attachment = notes.entry.attachments.find((item) => item.id === attachmentId && /\.(jpe?g|png|webp)$/i.test(item.filename));
    if (!attachment) throw new Error("请插入本条实验中的 JPEG、PNG 或 WebP 图片。");
    const cursor = notes.bodyCursor;
    const target = cursor?.element && root.contains(cursor.element) ? cursor.element : root.lastElementChild;
    const position = cursor?.element === target ? Math.min(cursor.position, target.value.length) : target.value.length;
    const following = bodyText(target.value.slice(position));
    target.value = target.value.slice(0, position);
    target.after(bodyImage(attachmentId), following);
    root.classList.add("has-images");
    notes.bodyFormat = "inline-images-v1";
    notes.bodyCursor = {element: following, position: 0};
    root.querySelectorAll("textarea").forEach(growBodyText);
    if (!notes.working) {following.focus(); following.setSelectionRange(0, 0);}
    if (dirty) markDirty();
  }

  async function uploadBodyImages(files) {
    if (!files.length || notes.working || !writable()) return;
    if (files.some((file) => !/\.(jpe?g|png|webp)$/i.test(file.name) || !file.size || file.size > 20 * 1024 * 1024)) throw new Error("正文图片请选择 20 MB 以内的 JPEG、PNG 或 WebP 文件。");
    if (byId("note-rich-body").querySelectorAll("figure").length + files.length > 50) throw new Error("每条正文最多插入 50 张图片。");
    await flush();
    if (notes.working || !writable()) return;
    notes.working = true;
    lockEditor();
    let inserted = 0;
    try {
      for (const file of files) {
        saveStatus(`正在保留原图并插入 ${inserted + 1}/${files.length}…`);
        notes.entry = await api("/api/notebook/attach", {id: notes.entry.id, revision: notes.entry.revision, filename: file.name, data: await fileBase64(file)});
        const attachment = notes.entry.attachments[notes.entry.attachments.length - 1];
        insertBodyImage(attachment.id, false);
        inserted += 1;
      }
    } catch (error) {
      if (!inserted) saveStatus("图片未插入，正文保留 · " + error.message, true);
      throw error;
    } finally {
      notes.working = false;
      byId("note-inline-files").value = "";
      renderRelated();
      if (inserted) {
        markDirty();
        await flush();
        notes.bodyCursor?.element.focus();
      }
    }
  }

  function saveStatus(text, error = false) {
    byId("note-save-state").textContent = text;
    byId("note-save-state").classList.toggle("save-error", error);
  }

  function bodyPreview(data) {
    return data.body_format ? data.body.replace(/\[\[colorlens-image:[0-9a-f]{32}\]\]/g, " [图片] ") : data.body;
  }

  function structuredVisibility() {
    byId("note-structured").hidden = byId("note-template").value !== "report" && !["purpose", "materials", "procedure", "results", "discussion"].some((key) => byId(`note-${key}`).value);
  }

  function markDirty() {
    if (!writable()) return;
    notes.generation += 1;
    notes.dirty = true;
    saveStatus("有未保存的修改…");
    structuredVisibility();
    clearTimeout(notes.timer);
    notes.timer = setTimeout(() => run(flush), 700);
  }

  async function flush() {
    await window.ColorLensCollaboration?.flush();
    clearTimeout(notes.timer);
    if (notes.saving) return notes.saving;
    if (!notes.dirty || !notes.entry) return;
    const entryId = notes.entry.id;
    notes.saving = (async () => {
      while (notes.dirty && notes.entry?.id === entryId) {
        const generation = notes.generation;
        const request = {id: entryId, revision: notes.entry.revision, data: readForm()};
        saveStatus("正在保存到云端…");
        let entry;
        try {entry = await api("/api/notebook/save", request);}
        catch (error) {
          // A lost response may follow a committed save; compare every normalized field before acknowledging it.
          try {
            const current = await api("/api/notebook/entry/" + entryId);
            if (window.ColorLensCloud.notebookDataMatches(current, request.data)) entry = current;
          } catch {}
          if (!entry) {
            if (notes.entry?.id === entryId) saveStatus("未保存，请勿关闭 · " + error.message, true);
            throw error;
          }
        }
        if (notes.entry?.id !== entryId) return;
        notes.entry = entry;
        if (notes.generation === generation) notes.dirty = false;
        saveStatus(notes.dirty ? "正在保存后续修改…" : `已保存 · ${stamp(entry.updated_at).slice(11)} · 版本 ${entry.revision}`);
        byId("note-editor-heading").textContent = entry.data.title;
      }
    })().finally(() => {notes.saving = null;});
    return notes.saving;
  }

  function lockEditor() {
    const locked = !writable() || notes.working;
    byId("note-form").querySelectorAll("input,select,textarea").forEach((element) => {element.disabled = locked;});
    for (const key of ["note-event-text", "note-add-event", "note-upload", "note-insert-image", "note-open-analysis", "note-complete", "note-save-now"]) byId(key).disabled = locked;
    byId("note-rich-body").querySelectorAll("button").forEach((button) => {button.disabled = locked;});
    for (const key of ["note-back", "note-new", "note-reopen", "note-duplicate", "note-trash", "note-recover", "note-export", "note-print"]) byId(key).disabled = notes.working;
    byId("note-lock-notice").hidden = writable();
    byId("note-lock-notice").textContent = notes.entry?.deleted ? "这条实验在回收站中，附件和历史仍然保留。恢复后可继续使用。" : "记录已完成，当前内容只读。需要补充时点击“添加修订”，填写原因后继续编辑；旧版本保留。";
    byId("note-complete").hidden = !writable();
    byId("note-reopen").hidden = !notes.entry || Boolean(notes.entry.deleted) || notes.entry.data.status !== "complete";
    byId("note-recover").hidden = !notes.entry?.deleted;
    byId("note-trash").hidden = Boolean(notes.entry?.deleted);
    byId("note-status-badge").textContent = notes.entry?.deleted ? "回收站" : notes.entry?.data.status === "complete" ? "已完成" : "进行中";
    document.querySelectorAll(".note-use-attachment").forEach((button) => {button.disabled = locked;});
    document.querySelectorAll(".note-insert-attachment").forEach((button) => {button.disabled = locked;});
  }

  function renderRelated() {
    if (!notes.entry) return;
    const entry = notes.entry;
    byId("note-attachment-count").textContent = entry.attachments.length;
    byId("note-attachments").innerHTML = entry.attachments.length ? entry.attachments.map((item) => {
      const photo = /\.(jpe?g|png|webp)$/i.test(item.filename);
      const csv = /\.csv$/i.test(item.filename);
      return `<article class="note-attachment">${photo ? `<a href="/api/notebook/attachment/${item.id}" download aria-label="下载 ${escapeHtml(item.filename)}"><img src="/api/notebook/preview/${item.id}" loading="lazy" alt="${escapeHtml(item.filename)}"></a>` : '<div class="attachment-file-icon" aria-hidden="true">▤</div>'}<div><strong title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</strong><small>${(item.size / 1024).toFixed(1)} KB · SHA-256 校验</small><div class="attachment-actions"><a href="/api/notebook/attachment/${item.id}" download>下载原件</a>${photo || csv ? `<button class="text-button note-use-attachment" data-attachment="${item.id}" data-photo="${photo}">${photo ? "用于照片比较" : "用于读数整理"} ↗</button>` : ""}</div></div></article>`;
    }).join("") : '<div class="note-side-empty">还没有附件。<br>原始资料可以边做实验边补充。</div>';
    byId("note-attachments").querySelectorAll(".note-attachment").forEach((article, index) => {
      if (!/\.(jpe?g|png|webp)$/i.test(entry.attachments[index].filename)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button note-insert-attachment";
      button.dataset.inlineAttachment = entry.attachments[index].id;
      button.textContent = "插入正文";
      article.querySelector(".attachment-actions").append(button);
    });
    byId("note-events").innerHTML = entry.events.length ? entry.events.map((event) => `<li><time>${escapeHtml(stamp(event.created_at))}</time><p>${escapeHtml(event.text)}</p></li>`).join("") : '<li class="timeline-empty">还没有过程记录。记录实际操作、观察与偏差，让结果有迹可循。</li>';
    byId("note-analyses").innerHTML = entry.analyses.length ? entry.analyses.map((item) => `<article class="note-analysis" data-analysis="${escapeHtml(item.record_id)}"><strong>分析快照</strong><small>${escapeHtml(item.record_id)}</small><span class="analysis-integrity">正在校验…</span><div><button class="text-button note-restore-analysis" data-record="${escapeHtml(item.record_id)}">在线查看</button><a href="/api/download/${escapeHtml(item.record_id)}" download>下载 ZIP（可选）</a></div></article>`).join("") : '<div class="note-side-empty">分析不是必填项。<br>没有数据也可以先记下实验。</div>';
    for (const item of entry.analyses) {
      api("/api/notebook/analysis/" + item.record_id).then((summary) => {
        if (notes.entry?.id !== entry.id) return;
        const row = [...byId("note-analyses").querySelectorAll("[data-analysis]")].find((element) => element.dataset.analysis === item.record_id);
        if (!row) return;
        row.querySelector("strong").textContent = summary.assay_name || (summary.analysis_type === "instrument" ? "仪器读数整理" : "照片颜色比较");
        row.querySelector(".analysis-integrity").textContent = summary.simulated ? "模拟数据 · 校验通过" : "用户输入数据 · 校验通过";
        row.querySelector(".analysis-integrity").classList.toggle("simulated", summary.simulated);
      }).catch(() => {
        const row = [...byId("note-analyses").querySelectorAll("[data-analysis]")].find((element) => element.dataset.analysis === item.record_id);
        if (row && notes.entry?.id === entry.id) row.querySelector(".analysis-integrity").textContent = "校验失败，请核对云端快照或备份";
      });
    }
    lockEditor();
  }

  function renderEditor() {
    const entry = notes.entry;
    for (const key of fields) byId(`note-${key}`).value = entry.data[key];
    byId("note-tags").value = entry.data.tags.join(", ");
    byId("note-editor-heading").textContent = entry.data.title;
    byId("note-editor-provenance").textContent = `创建于 ${stamp(entry.created_at)} · 记录 ${entry.id.slice(0, 8)}`;
    byId("note-event-text").value = entry.data.event_draft || "";
    renderBody();
    window.ColorLensTemplates.renderNote(entry);
    window.ColorLensSamples.renderNote(entry);
    structuredVisibility();
    renderRelated();
    saveStatus(`已保存到云端 · 版本 ${entry.revision}`);
  }

  function view(name) {
    const sections = {notebook: "notebook-view", ai: "ai-page", glasses: "glasses-page", analysis: "analysis-view", templates: "templates-page", teams: "teams-page", collaboration: "collaboration-page", samples: "samples-page", inventory: "inventory-page", equipment: "equipment-page", snapshots: "records-dialog", snapshot: "analysis-record-view", backup: "note-backup-dialog", guide: "notebook-guide-dialog"};
    for (const [route, identifier] of Object.entries(sections)) byId(identifier).hidden = name !== route;
    if (name !== "snapshot") window.ColorLensCloud.closeRecord();
    const labels = {analysis: "分析工具", templates: "实验模板", teams: "团队与评阅", collaboration: "实时协作", samples: "样本与冻存", inventory: "库存与采购", equipment: "设备与预约", snapshots: "分析快照", snapshot: "分析快照 · 在线查看", backup: "数据与备份", guide: "使用指南"};
    byId("page-location").textContent = name === "ai" ? "AI 分析" : labels[name] || (notes.entry && !byId("notebook-editor").hidden ? "实验笔记" : "我的实验");
    const navigation = {notebook: "nav-notebook", analysis: "nav-workbench", templates: "nav-templates", teams: "nav-teams", collaboration: "nav-collaboration", samples: "nav-samples", inventory: "nav-inventory", equipment: "nav-equipment", snapshots: "nav-archive", backup: "nav-backup", guide: "nav-guide"};
    navigation.ai = "nav-ai";
    navigation.glasses = "nav-glasses";
    for (const [route, identifier] of Object.entries(navigation)) {
      const active = route === name || route === "snapshots" && name === "snapshot";
      byId(identifier).classList.toggle("active", active);
      if (active) byId(identifier).setAttribute("aria-current", "page"); else byId(identifier).removeAttribute("aria-current");
    }
    document.querySelectorAll(".mobile-nav [data-view]").forEach((button) => {
      const active = button.dataset.view === name || button.dataset.view === "snapshots" && name === "snapshot";
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
    window.scrollTo({top: 0});
    if (name === "analysis") requestAnimationFrame(drawCanvas);
    else if (["ai", "snapshots", "snapshot", "backup", "guide"].includes(name)) byId(sections[name]).focus({preventScroll: true});
  }

  async function openPage(name, recordId) {
    await flush();
    setRoute(name === "snapshot" ? "snapshot/" + recordId : ["ai", "glasses", "samples", "inventory", "equipment", "collaboration"].includes(name) && recordId ? name + "/" + recordId : name);
    view(name);
    if (name === "ai") await window.ColorLensAiWorkspace.open(recordId);
    if (name === "glasses") { byId('page-location').textContent='眼镜采集'; await window.ColorLensGlasses.open(recordId); }
    if (name === "snapshots") {
      byId("records-list").textContent = "正在读取分析快照…";
      await archiveHandler();
    } else if (name === "backup") {
      byId("note-data-path").value = "正在读取当前账号空间…";
      byId("note-backup-status").textContent = "";
      const info = await api("/api/notebook/info");
      byId("note-data-path").value = info.data_directory;
      window.ColorLensCloud.updateStorage(info);
    } else if (name === "snapshot") await window.ColorLensCloud.openRecord(recordId);
    else if (name === "templates") await window.ColorLensTemplates.open();
    else if (name === "teams") await window.ColorLensTeams.open();
    else if (name === "samples") await window.ColorLensSamples.open(recordId);
    else if (name === "inventory") await window.ColorLensInventory.open(recordId);
    else if (name === "equipment") await window.ColorLensEquipment.open(recordId);
    else if (name === "collaboration") await window.ColorLensCollaboration.open(recordId);
  }

  function emptyList(query) {
    const filtered = ["q", "project", "kind", "status"].some(key => query.get(key));
    if (filtered) return '<div class="notebook-empty"><h3>没有找到符合条件的实验</h3><p>试试其他关键词，或清除筛选查看全部记录。</p><button type="button" class="button secondary" id="note-clear-filters">清除筛选</button></div>';
    if (notes.status === "trash") return '<div class="notebook-empty"><h3>回收站是空的</h3><p>移入回收站的记录会显示在这里。</p></div>';
    return '<div class="notebook-empty"><h3>还没有实验记录</h3><p>新建实验后，可以写笔记、插入照片和保存分析。</p><button type="button" class="button secondary" id="note-empty-new">＋ 新建实验记录</button></div>';
  }

  async function listNotes() {
    const serial = ++notes.listRequest;
    const query = new URLSearchParams({q: byId("note-search").value.trim(), project: byId("note-project-filter").value, kind: byId("note-kind-filter").value, status: notes.status === "trash" ? "" : notes.status, trash: notes.status === "trash" ? "1" : "0", offset: String(notes.offset)});
    const result = await api("/api/notebook?" + query);
    if (serial !== notes.listRequest) return;
    const unfiltered = !notes.offset && !notes.status && !["q", "project", "kind"].some(key => query.get(key));
    const recent = unfiltered && result.entries.find(entry => entry.data.status === "draft");
    const recentOpen = byId("note-recent-open");
    byId("note-recent").hidden = !recent;
    recentOpen.onclick = recent ? () => run(() => openEntry(recent.id)) : null;
    byId("note-recent-title").textContent = recent ? recent.data.title : "";
    byId("note-recent-meta").textContent = recent ? [recent.data.date, recent.data.project || kinds[recent.data.kind]].filter(Boolean).join(" · ") : "";
    notes.total = result.total;
    byId("note-total").textContent = result.counts.total;
    byId("note-drafts").textContent = result.counts.draft;
    byId("note-completed").textContent = result.counts.complete;
    const project = byId("note-project-filter").value;
    byId("note-project-filter").innerHTML = '<option value="">全部课程与课题</option>' + result.projects.map((item) => `<option>${escapeHtml(item)}</option>`).join("");
    byId("note-project-filter").value = project;
    byId("note-project-options").innerHTML = result.projects.map((item) => `<option value="${escapeHtml(item)}"></option>`).join("");
    byId("note-list-summary").textContent = `${result.total} 条${notes.status === "trash" ? "回收站" : ""}记录`;
    byId("note-list").innerHTML = result.entries.length ? result.entries.map((entry) => `<button class="notebook-entry-row" data-entry="${entry.id}"><span class="entry-symbol" aria-hidden="true">${entry.data.kind === "research" ? "⌘" : "▤"}</span><span class="entry-row-main"><span class="entry-row-title">${escapeHtml(entry.data.title)}</span><span class="entry-row-description">${escapeHtml((bodyPreview(entry.data) || entry.data.purpose || "还没有正文，可以从计划或一个观察开始。").replace(/\s+/g, " ").slice(0, 100))}</span><span class="entry-row-tags">${entry.data.tags.slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</span></span><span class="entry-row-meta"><span>${escapeHtml(entry.data.project || kinds[entry.data.kind])}</span><small>${escapeHtml(entry.data.date)}</small></span><span class="entry-state ${entry.data.status}">${entry.deleted ? "回收站" : entry.data.status === "complete" ? "已完成" : "进行中"}</span><span class="entry-arrow" aria-hidden="true">↗</span></button>`).join("") : emptyList(query);
    byId("note-prev").disabled = notes.offset === 0;
    byId("note-next").disabled = notes.offset + 40 >= result.total;
    byId("note-page-label").textContent = result.total ? `${notes.offset + 1}–${Math.min(notes.offset + 40, result.total)} / ${result.total}` : "";
  }

  async function dashboard({focusSearch = false} = {}) {
    if (notes.working) throw new Error("文件正在保存，请稍候。");
    await flush();
    notes.entry = null;
    byId("notebook-dashboard").hidden = false;
    byId("notebook-editor").hidden = true;
    setRoute("notebook");
    view("notebook");
    if (focusSearch) {
      const input = byId("note-search");
      input.focus({preventScroll:true});
      input.select();
      input.scrollIntoView({block:"center", behavior:"instant"});
    }
    await listNotes();
  }

  async function openEntry(entryId) {
    if (notes.working) throw new Error("请等待当前文件保存完成。");
    await flush();
    notes.entry = await api("/api/notebook/entry/" + entryId);
    notes.dirty = false;
    byId("notebook-dashboard").hidden = true;
    byId("notebook-editor").hidden = false;
    renderEditor();
    setRoute("entry/" + entryId);
    view("notebook");
  }

  async function createNote() {
    if (notes.working) return;
    await flush();
    const entry = await api("/api/notebook/create", {data: {title: "未命名实验", date: localDate(), kind: "course"}});
    await openEntry(entry.id);
    byId("note-title").focus();
    byId("note-title").select();
  }

  async function mutate(path, extra = {}) {
    if (notes.working) throw new Error("正在保存，请稍候。");
    await flush();
    notes.working = true;
    lockEditor();
    try {
      const entry = await api(path, {id: notes.entry.id, revision: notes.entry.revision, ...extra});
      notes.entry = entry;
      renderEditor();
      return entry;
    } finally {
      notes.working = false;
      lockEditor();
    }
  }

  async function download(path, filename) {
    await flush();
    await window.ColorLensCloud.download(path, filename);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function fileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = () => reject(new Error("文件读取失败，请重试。"));
      reader.readAsDataURL(file);
    });
  }

  function analysisLink() {
    if (!notes.entry || notes.analysisOwner !== notes.entry.id) return {};
    return {entry_id: notes.entry.id, entry_revision: notes.entry.revision};
  }

  async function prepareAnalysis() {
    await flush();
    if (notes.entry && notes.analysisOwner === notes.entry.id) {
      if (!writable()) throw new Error("请先返回笔记并添加修订，再保存新的分析。");
      byId("experiment-name").value = notes.entry.data.title;
      byId("shared-experiment-name").value = notes.entry.data.title;
      byId("experiment-date").value = notes.entry.data.date;
      byId("experiment-operator").value = notes.entry.data.operator;
    }
  }

  function analysisContext() {
    const linked = notes.entry && notes.analysisOwner === notes.entry.id;
    byId("analysis-context-label").textContent = linked ? `分析将保存到：${notes.entry.data.title}` : "独立分析 · 保存时会自动创建一条实验记录";
    byId("analysis-back-note").hidden = !linked;
    byId("analysis-unlink").hidden = !linked;
  }

  function resetAnalysis() {
    state.asset = null;
    state.image = null;
    state.rois = [];
    state.selected = null;
    state.control = null;
    state.result = null;
    state.instrumentResult = null;
    state.instrumentFilename = "";
    window.ColorLensMethods.selectAssay("generic");
    byId("instrument-csv").value = "";
    byId("instrument-unit").value = "";
    byId("instrument-reference-wavelength").value = "";
    byId("instrument-subtract").checked = false;
    byId("instrument-simulated").checked = false;
    instrumentSimulatedLocked = false;
    for (const key of ["device", "lighting", "reaction-time", "notes", "manufacturer", "catalog-number", "species", "lot", "protocol-version"]) byId("experiment-" + key).value = "";
    context.clearRect(0, 0, canvas.width, canvas.height);
    byId("stage-loading").hidden = false;
    byId("stage-loading").innerHTML = "<span>请导入照片，或从实验附件中选择原图</span>";
    byId("image-provenance").textContent = "尚未导入照片";
    byId("image-filename").textContent = "选择照片以开始";
    byId("image-size").textContent = "—";
    byId("source-badge").textContent = "等待导入";
    byId("import-kind").value = "real";
    byId("import-kind").disabled = false;
    renderAll();
    window.ColorLensMethods.renderPath();
  }

  async function showAnalysis(linked = true, review = false) {
    if (state.busy || notes.working) throw new Error("请等待当前操作完成。");
    await flush();
    const owner = linked && notes.entry ? notes.entry.id : null;
    if (owner && !writable() && !review) throw new Error("已完成的记录请先添加修订，再新增分析。");
    if (owner !== notes.analysisOwner) {
      const realInput = state.asset && !state.asset.simulated || byId("instrument-csv").value && !byId("instrument-simulated").checked;
      if (realInput && !confirm("切换实验会清空分析工具中尚未保存的输入。原始附件和已保存快照不受影响。继续吗？")) return false;
      resetAnalysis();
    }
    notes.analysisOwner = owner;
    if (!linked) notes.entry = null;
    if (owner) {
      if (writable()) await prepareAnalysis();
    }
    analysisContext();
    setRoute(owner ? "analysis/" + owner : "analysis");
    view("analysis");
    return true;
  }

  async function analysisSaved(saved) {
    if (notes.entry?.id !== saved.entry_id) return;
    const generation = notes.generation;
    const entry = await api("/api/notebook/entry/" + saved.entry_id);
    if (notes.entry?.id !== saved.entry_id || entry.revision < notes.entry.revision) return;
    if (notes.dirty) {
      saveStatus("分析快照已关联保存；正文仍有未保存修改，请保留输入并核对版本。", true);
      return;
    }
    if (notes.saving || notes.generation !== generation) return;
    notes.entry = entry;
    notes.analysisOwner = saved.entry_id;
    if (currentRoute === "analysis" || currentRoute === "analysis/" + saved.entry_id) setRoute("analysis/" + saved.entry_id);
    analysisContext();
    renderEditor();
    byId("notebook-dashboard").hidden = true;
    byId("notebook-editor").hidden = false;
  }

  async function restoreAnalysis(recordId, entryId) {
    if (state.busy) return;
    await flush();
    if (entryId && notes.entry?.id !== entryId) await openEntry(entryId);
    if (!await showAnalysis(true, true)) return;
    setBusy(true, "复核分析快照…");
    try {
      const record = await api("/api/restore", {id: recordId});
      if (record.analysis_type === "instrument") await window.ColorLensMethods.restoreInstrument(record);
      else {
        await loadAsset(record);
        state.result = await api("/api/analyze", payload());
        renderAll();
      }
      toast("快照校验通过，已重新计算。原快照没有被覆盖。");
    } finally {setBusy(false);}
  }

  async function history(more = false) {
    await flush();
    if (!more) {
      notes.historyOffset = 0;
      byId("note-history-list").innerHTML = "";
      byId("note-history-preview").hidden = true;
    }
    const result = await api(`/api/notebook/history/${notes.entry.id}?offset=${notes.historyOffset}`);
    notes.historyTotal = result.total;
    notes.historyOffset += result.items.length;
    byId("note-history-list").insertAdjacentHTML("beforeend", result.items.map((item) => `<button class="note-history-row" data-revision="${item.revision}"><span><strong>版本 ${item.revision}</strong> · ${escapeHtml(item.reason)}</span><small>${escapeHtml(stamp(item.created_at))}</small></button>`).join(""));
    byId("note-history-more").hidden = notes.historyOffset >= notes.historyTotal;
    if (!byId("note-history-dialog").open) byId("note-history-dialog").showModal();
  }

  async function openBackup() {
    await openPage("backup");
  }

  async function chooseAttachment(attachmentId, photo) {
    await flush();
    if (!writable()) throw new Error("请先添加修订或恢复记录。");
    notes.attachment = {id: attachmentId, photo};
    const item = notes.entry.attachments.find((attachment) => attachment.id === attachmentId);
    byId("note-attachment-description").textContent = `原始附件：${item.filename}。载入分析工具不会修改附件。`;
    byId("note-attachment-assay").innerHTML = (photo ? "" : '<option value="">请选择实际使用的方法</option>') + catalog.filter((assay) => photo ? assay.photo_allowed : assay.instrument_allowed).map((assay) => `<option value="${assay.id}">${escapeHtml(assay.name)}</option>`).join("");
    byId("note-attachment-simulated").checked = notes.entry.data.tags.includes("模拟数据");
    byId("note-attachment-dialog").showModal();
  }

  byId("note-form").onsubmit = (event) => event.preventDefault();
  byId("note-form").addEventListener("input", markDirty);
  const bodyRoot = byId("note-rich-body");
  bodyRoot.addEventListener("input", (event) => {
    if (event.target.matches(".note-body-text")) {growBodyText(event.target); rememberBodyCursor(event);}
  });
  for (const eventName of ["focusin", "focusout", "keyup", "pointerup", "select"]) bodyRoot.addEventListener(eventName, rememberBodyCursor);
  bodyRoot.addEventListener("click", (event) => run(() => {
    const button = event.target.closest("[data-remove-inline]");
    if (!button || !writable() || notes.working) return;
    event.preventDefault();
    const figure = button.closest("figure");
    const before = figure.previousElementSibling;
    const after = figure.nextElementSibling;
    const position = before.value.length;
    before.value += after.value;
    after.remove();
    figure.remove();
    bodyRoot.classList.toggle("has-images", Boolean(bodyRoot.querySelector("figure")));
    growBodyText(before);
    before.focus();
    before.setSelectionRange(position, position);
    notes.bodyCursor = {element: before, position};
    markDirty();
    toast("图片已移出正文，原始附件仍然保留。");
  }));
  bodyRoot.addEventListener("paste", (event) => {
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    rememberBodyCursor(event);
    run(() => uploadBodyImages(files));
  });
  bodyRoot.addEventListener("dragover", (event) => {if (event.dataTransfer.types.includes("Files")) event.preventDefault();});
  bodyRoot.addEventListener("drop", (event) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    rememberBodyCursor(event);
    run(() => uploadBodyImages([...event.dataTransfer.files]));
  });
  byId("note-insert-image").onclick = () => byId("note-inline-files").click();
  byId("note-inline-files").onchange = () => run(() => uploadBodyImages([...byId("note-inline-files").files]));
  byId("note-event-text").addEventListener("input", markDirty);
  byId("note-new").onclick = () => run(createNote);
  byId("note-back").onclick = () => run(dashboard);
  byId("nav-notebook").onclick = () => run(dashboard);
  byId("nav-workbench").onclick = () => run(() => showAnalysis(Boolean(notes.entry)));
  const archiveHandler = byId("nav-archive").onclick;
  byId("nav-archive").onclick = () => run(() => openPage("snapshots"));
  byId("sidebar-demo").onclick = () => run(async () => {if (await showAnalysis(false)) await demo();});
  byId("note-save-now").onclick = () => run(flush);
  byId("note-list").onclick = (event) => run(async () => {
    const row = event.target.closest("[data-entry]");
    if (row) await openEntry(row.dataset.entry);
    else if (event.target.closest("#note-empty-new")) await createNote();
    else if (event.target.closest("#note-clear-filters")) {
      clearTimeout(searchTimer);
      for (const control of ["note-search", "note-project-filter", "note-kind-filter"]) byId(control).value = "";
      setNoteStatus("");
      updateFilterLabel();
      byId("note-search").focus();
      await listNotes();
    }
  });
  let searchTimer;
  byId("note-search").oninput = () => {clearTimeout(searchTimer); searchTimer = setTimeout(() => {notes.offset = 0; run(listNotes);}, 200);};
  const toggleFilters = byId("note-toggle-filters");
  function updateFilterLabel() {
    const count = ["note-project-filter", "note-kind-filter"].filter(id => byId(id).value).length;
    toggleFilters.textContent = count ? `筛选（${count}）` : "筛选";
  }
  toggleFilters.onclick = () => toggleFilters.setAttribute("aria-expanded", String(toggleFilters.getAttribute("aria-expanded") !== "true"));
  byId("note-extra-filters").addEventListener("keydown", event => {
    if (event.key === "Escape" && toggleFilters.getClientRects().length) {
      toggleFilters.setAttribute("aria-expanded", "false");
      toggleFilters.focus();
    }
  });
  for (const key of ["note-project-filter", "note-kind-filter"]) byId(key).onchange = () => {
    updateFilterLabel();
    notes.offset = 0;
    run(listNotes);
  };
  function setNoteStatus(status) {
    notes.status = status;
    notes.offset = 0;
    for (const item of document.querySelectorAll("[data-note-status]")) {
      const selected = item.dataset.noteStatus === status;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    }
  }
  setNoteStatus(notes.status);
  document.querySelectorAll("[data-note-status]").forEach((button) => {button.onclick = () => {
    setNoteStatus(button.dataset.noteStatus);
    run(listNotes);
  };});
  byId("note-prev").onclick = () => {notes.offset = Math.max(0, notes.offset - 40); run(listNotes);};
  byId("note-next").onclick = () => {notes.offset += 40; run(listNotes);};
  byId("note-add-event").onclick = () => run(() => mutate("/api/notebook/event", {text: byId("note-event-text").value}));
  byId("note-upload").onclick = () => byId("note-files").click();
  byId("note-files").onchange = () => run(async () => {
    const files = [...byId("note-files").files];
    await flush();
    if (!writable() || notes.working) return;
    notes.working = true;
    lockEditor();
    let count = 0;
    try {
      for (const file of files) {
        if (!file.size || file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 为空或超过 20 MB；此前已保存 ${count} 个附件。`);
        saveStatus(`正在保存附件 ${count + 1}/${files.length}…`);
        notes.entry = await api("/api/notebook/attach", {id: notes.entry.id, revision: notes.entry.revision, filename: file.name, data: await fileBase64(file)});
        count += 1;
      }
      toast(`已保留 ${count} 个原始附件。`);
    } finally {
      notes.working = false;
      byId("note-files").value = "";
      renderRelated();
      saveStatus(`已保存到云端 · 版本 ${notes.entry.revision}`);
    }
  });
  byId("note-attachments").onclick = (event) => {
    const inline = event.target.closest("[data-inline-attachment]");
    if (inline) return run(() => insertBodyImage(inline.dataset.inlineAttachment));
    const button = event.target.closest("[data-attachment]");
    if (button) run(() => chooseAttachment(button.dataset.attachment, button.dataset.photo === "true"));
  };
  byId("note-attachment-use").onclick = () => run(async () => {
    const selected = byId("note-attachment-assay").value;
    if (!selected) throw new Error("请先选择实际实验方法。");
    if (!await showAnalysis()) return;
    setBusy(true, "载入原始附件…");
    byId("note-attachment-use").disabled = true;
    try {
      const simulated = byId("note-attachment-simulated").checked;
      const attachment = notes.entry.attachments.find((item) => item.id === notes.attachment.id);
      if (notes.attachment.photo) {
        const asset = await api("/api/notebook/photo", {attachment_id: notes.attachment.id, simulated});
        window.ColorLensMethods.selectAssay(selected);
        await loadAsset({...asset, assay_id: selected});
      } else {
        const response = await fetch("/api/notebook/attachment/" + notes.attachment.id);
        if (!response.ok) throw new Error((await response.json()).error);
        const bytes = await response.arrayBuffer();
        let text;
        try {text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);} catch {text = new TextDecoder("gb18030", {fatal: true}).decode(bytes);}
        window.ColorLensMethods.loadInstrumentAttachment(text, attachment.filename, simulated, selected);
      }
      await prepareAnalysis();
      byId("note-attachment-dialog").close();
      toast("原始附件已载入。请检查方法与参数，再执行分析。");
    } finally {setBusy(false); byId("note-attachment-use").disabled = false;}
  });
  byId("note-open-analysis").onclick = () => run(() => showAnalysis());
  byId("analysis-back-note").onclick = () => run(() => openEntry(notes.entry.id));
  byId("analysis-unlink").onclick = () => run(() => showAnalysis(false));
  byId("note-analyses").onclick = (event) => {
    const button = event.target.closest("[data-record]");
    if (button) run(() => openPage("snapshot", button.dataset.record));
  };
  byId("note-complete").onclick = () => run(async () => {
    if (!confirm("完成后笔记将设为只读，后续补充需要填写修订原因。确认完成吗？")) return;
    await flush();
    await mutate("/api/notebook/save", {data: {...notes.entry.data, status: "complete"}});
  });
  byId("note-reopen").onclick = () => run(async () => {
    const reason = prompt("请填写修订原因（旧版本会保留）：");
    if (reason !== null) await mutate("/api/notebook/action", {action: "reopen", reason});
  });
  byId("note-trash").onclick = () => run(async () => {
    if (!confirm("将这条实验移入回收站？资料和历史会保留，可以恢复。")) return;
    await mutate("/api/notebook/action", {action: "trash"});
    await dashboard();
  });
  byId("note-recover").onclick = () => run(() => mutate("/api/notebook/action", {action: "recover"}));
  byId("note-duplicate").onclick = () => run(async () => {
    await flush();
    const entry = await api("/api/notebook/duplicate", {id: notes.entry.id});
    await openEntry(entry.id);
    toast("已复制目的、材料与方案。旧笔记、结果、讨论、附件和分析没有复制。");
  });
  byId("note-export").onclick = () => run(() => download("/api/notebook/export/" + notes.entry.id, "ColorLens-experiment-" + notes.entry.id.slice(0, 8) + ".zip"));
  byId("note-print").onclick = () => run(async () => {
    await flush();
    const link = document.createElement("a");
    link.href = "/api/notebook/report/" + notes.entry.id;
    link.target = "_blank";
    link.rel = "noopener";
    link.click();
    toast("在报告窗口使用 Ctrl+P，可打印或另存为 PDF。");
  });
  byId("note-recovery-download").onclick = () => {
    const data = readForm();
    const content = JSON.stringify({notice: "当前界面输入副本，不代表已保存；可用来手动找回冲突输入。", entry_id: notes.entry.id, data}, null, 2);
    downloadBlob(new Blob([content], {type: "text/plain;charset=utf-8"}), "ColorLens-unsaved-note.txt");
  };
  byId("note-history").onclick = () => run(() => history());
  byId("note-history-more").onclick = () => run(() => history(true));
  byId("note-history-list").onclick = (event) => run(async () => {
    const row = event.target.closest("[data-revision]");
    if (!row) return;
    const entry = await api(`/api/notebook/revision/${notes.entry.id}/${row.dataset.revision}`);
    byId("note-history-preview").textContent = JSON.stringify(entry, null, 2);
    byId("note-history-preview").hidden = false;
    byId("note-history-preview").focus();
  });
  byId("nav-backup").onclick = () => run(openBackup);
  byId("nav-guide").onclick = () => run(() => openPage("guide"));
  byId("note-analysis-guide").onclick = () => byId("guide-dialog").scrollIntoView({behavior: "smooth"});
  byId("note-backup-export").onclick = () => run(async () => {
    byId("note-backup-status").textContent = "正在校验并打包，请稍候…";
    try {
      await download("/api/notebook/backup", "ColorLens-backup-" + localDate() + ".zip");
      byId("note-backup-status").textContent = "备份已交给浏览器下载。请将 ZIP 保存在另一块磁盘，并确认下载完成。";
    } catch (error) {byId("note-backup-status").textContent = error.message; throw error;}
  });
  byId("note-backup-import").onclick = () => byId("note-backup-file").click();
  byId("note-backup-file").onchange = () => run(async () => {
    const file = byId("note-backup-file").files[0];
    if (!file) return;
    try {
      if (file.size > 128 * 1024 * 1024) throw new Error("请选择 128 MB 以内的镜析备份。");
      await flush();
      byId("note-backup-status").textContent = "正在校验备份并合并新记录，不覆盖已有编号…";
      const result = await api("/api/notebook/restore", {data: await fileBase64(file)});
      byId("note-backup-status").textContent = `恢复完成：新增 ${result.imported} 条，相同编号跳过 ${result.skipped} 条。`;
      await listNotes();
    } catch (error) {byId("note-backup-status").textContent = error.message; throw error;}
    finally {byId("note-backup-file").value = "";}
  });
  byId("note-import-legacy").onclick = () => run(async () => {
    await flush();
    byId("note-backup-status").textContent = "正在检查 D 盘 V0.1 / V0.2 记录，原文件不会修改…";
    const result = await api("/api/notebook/import-legacy", {});
    byId("note-backup-status").textContent = `旧版导入：新增 ${result.imported} 条，跳过重复 ${result.skipped} 条，异常 ${result.failures.length} 条。` + (result.failures.length ? "\n" + result.failures.map((item) => item.id + "：" + item.error).join("\n") : "");
    await listNotes();
  });
  document.querySelectorAll("[data-view]").forEach((button) => {button.onclick = () => run(() => button.dataset.view === "analysis" ? showAnalysis(Boolean(notes.entry)) : button.dataset.view === "notebook" ? dashboard() : openPage(button.dataset.view));});
  window.addEventListener("beforeunload", (event) => {
    if (notes.dirty || notes.saving || notes.working) {event.preventDefault(); event.returnValue = "";}
  });
  document.addEventListener("visibilitychange", () => {if (document.visibilityState === "hidden" && notes.dirty) run(flush);});
  window.ColorLensNotebook = {analysisLink, prepareAnalysis, analysisSaved, flush, openEntry, openPage, focusSearch: () => run(() => dashboard({focusSearch:true})), reviewAnalysis: restoreAnalysis, getEntry: () => notes.entry};

  async function navigateHash() {
    await Promise.all([window.ColorLensCatalogReady, window.ColorLensDemoReady]);
    const target = location.hash.slice(1).split("/");
    const previous = currentRoute;
    routing = true;
    try {
      if (["entry", "analysis"].includes(target[0]) && /^[0-9a-f]{32}$/.test(target[1] || "")) {
        await openEntry(target[1]);
        if (target[0] === "analysis") await showAnalysis(true, true);
      } else if (target[0] === "analysis") await showAnalysis(false);
      else if (target[0] === "ai") await openPage("ai", /^[a-f0-9]{32}$/.test(target[1] || "") ? target[1] : undefined);
      else if (target[0] === "glasses") await openPage("glasses", /^[a-f0-9]{32}$/.test(target[1] || "") ? target[1] : undefined);
      else if (["snapshots", "backup", "guide", "templates", "teams"].includes(target[0])) await openPage(target[0]);
      else if (target[0] === "samples") await openPage("samples", /^[a-f0-9]{32}$/.test(target[1] || "") ? target[1] : undefined);
      else if (target[0] === "inventory") await openPage("inventory", ["lot", "purchase"].includes(target[1]) && /^[a-f0-9]{32}$/.test(target[2] || "") ? target[1] + "/" + target[2] : undefined);
      else if (target[0] === "equipment") await openPage("equipment", /^[a-f0-9]{32}$/.test(target[1] || "") ? target[1] : undefined);
      else if (target[0] === "collaboration") await openPage("collaboration", /^[a-f0-9]{32}$/.test(target[1] || "") ? target[1] : undefined);
      else if (target[0] === "snapshot" && /^[a-f0-9]{32}$/.test(target[1] || "")) await openPage("snapshot", target[1]);
      else await dashboard();
    } catch (error) {
      setRoute(previous);
      throw error;
    } finally {routing = false;}
  }
  let navigation = Promise.resolve();
  window.addEventListener("hashchange", () => {
    navigation = navigation.catch(() => {}).then(navigateHash);
    run(() => navigation);
  });
  run(navigateHash);
})();
