import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const web=new URL('../web/',import.meta.url);
const read=name=>readFileSync(new URL(name,web),'utf8');
test('scientific visual refresh covers public application/report/share/export entry points without external dependencies',()=>{
  for(const name of ['index.html','share.html','report.html','download.html'])assert.match(read(name),/href="\/scientific\.css"/);
  assert.match(read('index.html'),/src="\/scientific-ui\.js"/);assert.match(read('index.html'),/id="note-rich-body"/);assert.match(read('index.html'),/id="main-workspace"/);
  const theme=read('scientific.css');assert.match(theme,/prefers-reduced-motion/);assert.match(theme,/focus-visible/);assert.match(theme,/\.image-stage canvas\{filter:none;opacity:1\}/);assert.ok(!/@import|https?:\/\//.test(theme));
});
test('offline visual refresh remains inside the existing cached stylesheet and does not cache private API responses',()=>{
  assert.match(read('offline.css'),/--scientific-accent:#285fce/);const worker=read('offline-worker.js');assert.match(worker,/const assets=\['\/offline.html','\/offline.css','\/offline.js','\/favicon.svg'\]/);assert.ok(!worker.includes("'/api/"));assert.ok(!/fetch\(|localStorage|indexedDB|XMLHttpRequest/.test(read('scientific-ui.js')));
});
