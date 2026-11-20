import {request} from './transport.mjs';
import {downloadAnalysis} from './archives.mjs';
const status=document.getElementById('download-status');
(async()=>{
  const identity=await request('/api/auth/me');if(!identity.user)throw new Error('请先登录镜析再导出。');window.COLORLENS={token:identity.csrf};
  const match=location.hash.match(/^#analysis\/([a-f0-9]{32})$/);if(!match)throw new Error('导出编号无效。');
  await downloadAnalysis(match[1]);status.textContent='ZIP 已交给浏览器下载，请确认保存完成。';
})().catch(error=>{status.textContent=error.message;});
