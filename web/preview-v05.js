document.addEventListener('DOMContentLoaded',()=>{
  const set=(selector,text)=>{const element=document.querySelector(selector);if(element)element.textContent=text;};
  set('.workspace-label span','LOCAL TEST');
  set('.tiny-label','独立本机验收空间');
  set('.notebook-footer span:last-child','本机独立保存 · AI 按次联网授权 · 非临床用途');
  set('.sidebar-footer','测试记录保存在当前 Windows 用户的独立目录');
  const storageLabel=document.querySelector('#note-backup-dialog label');
  if(storageLabel?.firstChild?.nodeType===Node.TEXT_NODE)storageLabel.firstChild.textContent='当前本机验收空间';
});
