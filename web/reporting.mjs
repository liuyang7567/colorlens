export function renderRecord(target,entry,imageUrl) {
  const heading=document.createElement('h1');heading.textContent=entry.data.title;
  const metadata=document.createElement('p');metadata.textContent=`${entry.data.date} · ${entry.data.project||'未分类'} · ${entry.data.operator||'未填写操作者'} · 版本 ${entry.revision}`;
  target.append(heading,metadata);
  if(entry.data.template_binding){
    const binding=entry.data.template_binding,section=document.createElement('section'),title=document.createElement('h2');title.textContent='模板来源与结构化字段';section.append(title);const source=document.createElement('p');source.textContent=`${binding.definition.title} · 版本 ${binding.revision} · ${binding.source==='imported'?'导入来源':'创建时模板快照'}`;section.append(source);
    for(const field of binding.definition.fields){const row=document.createElement('p');const value=entry.data.template_values[field.key];row.textContent=field.label+'：'+(field.type==='checkbox'?value?'已勾选':'未勾选':value||'未填写')+(field.unit?' '+field.unit:'');section.append(row);}
    for(const [index,step] of binding.definition.steps.entries()){const row=document.createElement('p');row.textContent=(entry.data.template_checks[index]?'已勾选 · ':'未勾选 · ')+step;section.append(row);}target.append(section);
  }
  const labels={body:'实验笔记',purpose:'实验目的',materials:'材料与试剂',procedure:'实验方案与步骤',results:'实际结果',discussion:'讨论与下一步'};
  for (const [key,title] of Object.entries(labels)) {
    const value=entry.data[key];if(!value)continue;
    const section=document.createElement('section'),label=document.createElement('h2');label.textContent=title;section.append(label);
    const parts=key==='body'&&entry.data.body_format==='inline-images-v1'?value.split(/\[\[colorlens-image:([a-f0-9]{32})\]\]/g):[value];
    for(const [index,part] of parts.entries()){
      if(index%2){const file=entry.attachments.find(item=>item.id===part);if(!file)continue;const figure=document.createElement('figure'),image=document.createElement('img'),caption=document.createElement('figcaption');image.alt=file.filename;image.dataset.attachment=part;if(imageUrl)image.src=imageUrl(part);caption.textContent=file.filename;figure.append(image,caption);section.append(figure);}
      else{const text=document.createElement('pre');text.textContent=part;section.append(text);}
    }
    target.append(section);
  }
  const timeline=document.createElement('h2');timeline.textContent='过程时间线';target.append(timeline);
  for(const event of entry.events||[]){const row=document.createElement('p');row.textContent=event.created_at+' · '+event.text;target.append(row);}
  const footer=document.createElement('small');footer.textContent=`镜析 ColorLens V0.4 · ${entry.id} · 导出/查看版本 ${entry.revision}。原始观察与 AI 草稿分开；哈希不是电子签名。非临床用途。`;target.append(footer);
}
