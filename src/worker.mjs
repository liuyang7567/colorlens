import {AppError,check,body,json,sha} from './common.mjs';
import {authRoute,session,csrf,sameOrigin,rate} from './auth.mjs';
import {notebookRoute,upload,shareRoute,publicShare} from './notebook.mjs';
import {analysisRoute} from './analyses.mjs';
import {aiRoute} from './ai.mjs';
import {templatesRoute} from './templates.mjs';
import {teamsRoute} from './teams.mjs';
import {samplesRoute} from './samples.mjs';
import {inventoryRoute} from './inventory.mjs';
import {equipmentRoute} from './equipment.mjs';
import {syncRoute} from './sync.mjs';
import {collaborationRoute} from './collaboration.mjs';
import {issueCaptureTicket,verifyCaptureTicket} from './capture.mjs';
import {guidanceRoute} from './guidance.mjs';

const headers={
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; font-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
  'Cache-Control':'no-store, private'
};
export default {async fetch(request,env,context) {
  const url=new URL(request.url), path=url.pathname;
  let response;
  try {
    if (path.startsWith('/api/')) {
      check(['GET','POST'].includes(request.method),'不支持此请求方式。',405);
      const isPost=request.method==='POST';
      const postOnly=path.startsWith('/api/equipment/')||path.startsWith('/api/inventory/')||path.startsWith('/api/samples/')||path.startsWith('/api/teams/')||path.startsWith('/api/templates/')||path.startsWith('/api/ai/')||path.startsWith('/api/shares/')||path.startsWith('/api/files/')||path==='/api/restore'||path.includes('/instrument/')||['/api/notebook/create','/api/notebook/save','/api/notebook/action','/api/notebook/event','/api/notebook/duplicate','/api/analysis/photo'].includes(path);
      check(!(path.startsWith('/api/sync/')||path.startsWith('/api/collaboration/')||path.startsWith('/api/guidance/'))||isPost,'此接口必须通过 POST 提交。',405);
      check(!postOnly||isPost,'此接口必须通过 POST 提交。',405);
      const payload=isPost?await body(request,['/api/files/chunk','/api/guidance/observe'].includes(path)?1100000:500000):undefined;
      if (path==='/api/health') response=json({ok:true,version:'0.10.0-preview.19',cloud:true});
      else if (path.startsWith('/api/auth/')) {
        check(['/api/auth/me','/api/auth/config'].includes(path)?!isPost:isPost,'请求方式错误。',405);
        response=await authRoute(env,request,path,payload);
      } else if (path==='/api/capture/verify') {
        check(isPost,'此接口必须通过 POST 提交。',405);sameOrigin(request);
        await rate(env,'capture-verify:'+await sha(request.headers.get('CF-Connecting-IP')||'local'),120,60);
        response=json(await verifyCaptureTicket(env,payload,url.origin));
      } else if (path==='/api/public/share') {
        check(isPost,'请求方式错误。',405);sameOrigin(request);
        await rate(env,'share:'+await sha(request.headers.get('CF-Connecting-IP')||'local'),120,60);
        response=await publicShare(env,request,payload);
      } else {
        const user=await session(env,request);
        if (isPost) csrf(request,user);
        if(path==='/api/capture/ticket'){check(isPost,'此接口必须通过 POST 提交。',405);response=json(await issueCaptureTicket(env,user,payload,url.origin));}
        else if(path.startsWith('/api/guidance/')) response=await guidanceRoute(env,user,path,payload,request,context);
        else if(path.startsWith('/api/sync/')) response=await syncRoute(env,user,path,payload);
        else if(path.startsWith('/api/collaboration/')) response=await collaborationRoute(env,user,path,payload);
        else if (path==='/api/equipment'||path.startsWith('/api/equipment/')) response=await equipmentRoute(env,user,path,payload);
        else if (path==='/api/inventory'||path.startsWith('/api/inventory/')) response=await inventoryRoute(env,user,path,payload);
        else if (path==='/api/samples'||path.startsWith('/api/samples/')) response=await samplesRoute(env,user,path,payload);
        else if (path==='/api/teams'||path.startsWith('/api/teams/')) response=await teamsRoute(env,user,path,payload);
        else if (path==='/api/templates'||path.startsWith('/api/templates/')) response=await templatesRoute(env,user,path,payload);
        else if (path.startsWith('/api/files/')) response=json(await upload(env,user,path,payload));
        else if (path.startsWith('/api/shares/')) response=json(await shareRoute(env,user,path,payload));
        else if (path.startsWith('/api/ai/')) response=await aiRoute(env,user,path,payload,context);
        else if (path.startsWith('/api/download/')) response=Response.redirect(url.origin+'/download.html#analysis/'+path.split('/').at(-1),302);
        else if (path.startsWith('/api/notebook/report/')) {
          await notebookRoute(env,user,request,path.replace('/report/','/entry/'),payload,url);
          response=Response.redirect(url.origin+'/report.html#'+path.split('/').at(-1),302);
        }
        else if (path.startsWith('/api/notebook/') && !path.startsWith('/api/notebook/analysis/') || path==='/api/notebook') response=await notebookRoute(env,user,request,path,payload,url);
        else response=await analysisRoute(env,user,path,payload);
      }
    } else {
      check(request.method==='GET'||request.method==='HEAD','不支持此请求方式。',405);
      check(!/\/\.|%2e|\\/i.test(path),'路径无效。',404);
      const assetUrl=new URL(request.url);
      response=await env.ASSETS.fetch(new Request(assetUrl,request));
    }
  } catch(error) {
    const message=String(error.message||'');
    if (error instanceof AppError) response=json({error:error.message},error.status);
    else if (message.includes('DOCUMENT_QUOTA')) response=json({error:'试用版文字与历史容量已满（每人 10 MB / 全站 40 MB）。请先导出备份并联系管理员扩容；输入未覆盖。'},413);
    else if (message.includes('FILE_QUOTA')) response=json({error:'试用版附件空间已满（每人 50 MB / 全站 150 MB）。请导出备份并联系管理员扩容。'},413);
    else if (message.includes('SYNC_LIMIT')) response=json({error:'已保留 2000 次离线同步凭据，请联系管理员扩容；本地修改未清除。'},409);
    else if (message.includes('COLLAB_LIMIT')) response=json({error:'协作试用上限：每团队 40 份文档，每份 2000 版；请导出并联系管理员扩容。'},409);
    else if (message.includes('COLLAB_SCOPE')) response=json({error:'协作项目不属于当前团队。'},409);
    else if (/UNIQUE constraint failed: (sync_operations|collaboration_operations)/.test(message)) response=json({error:'此同步请求已在另一窗口处理，请保留原编号重试核对。'},409);
    else if (message.includes('AI_QUOTA')) response=json({error:'今日 AI 次数已用完（每人 10 次 / 全站 100 次，UTC 日期），明日重置。'},429);
    else if (message.includes('GUIDANCE_LIMIT')) response=json({error:'指导预览上限：每人 20 份会话，每份 150 条事件。请先导出并规划容量。'},409);
    else if (message.includes('GUIDANCE_SCOPE')) response=json({error:'指导记录不属于当前账号或实验。'},403);
    else if (message.includes('guidance_events.id')||message.includes('guidance_runs.id')) response=json({error:'此指导请求已被另一窗口处理，请刷新并保留原编号核对。'},409);
    else if (message.includes('TEAM_LIMIT')) response=json({error:'已达到团队试用上限：每人创建 3 个团队/加入 20 个，每队 30 位成员、30 个待接受邀请、20 个项目、100 份提交，每份 30 版/200 条动态。请联系管理员规划扩容。'},409);
    else if (message.includes('SAMPLE_LIMIT')) response=json({error:'已达到样本试用上限：每空间 500 个样本、40 个冻存盒，每样本 160 条流水；每人 1000 个实验关联、每实验 100 个关联。请联系管理员扩容。'},409);
    else if (message.includes('INVENTORY_LIMIT')) response=json({error:'库存试用上限：每空间 500 个批次、每队 200 份采购，每批次/申请 160 条流水、每申请 100 次到货。请先导出并联系管理员扩容。'},409);
    else if (message.includes('EQUIPMENT_LIMIT')) response=json({error:'设备试用上限：每空间 100 台设备，每台 500 份预约、1200 条普通动态；取消仍可保留。请联系管理员扩容。'},409);
    else if (message.includes('BOOKING_CONFLICT')) response=json({error:'所选时段已有预约，不能重叠。此次操作已整体撤销，请刷新选择空闲时段。'},409);
    else if (message.includes('UNIQUE constraint failed: equipment_devices')) response=json({error:'当前空间的设备编号已经存在，未重复登记。'},409);
    else if (message.includes('INVENTORY_SCOPE')) response=json({error:'批次身份、采购数量/单位或到货空间不匹配，操作已整体撤销。'},409);
    else if (/UNIQUE constraint failed: (inventory_lots|inventory_receipts)/.test(message)) response=json({error:'批次编号或到货编号已存在。此次操作未重复入库，请刷新核对。'},409);
    else if (/UNIQUE constraint failed: (lab_samples|sample_boxes)/.test(message)) response=json({error:'样本编号、冻存盒路径或孔位已被占用。原数量与位置未改变，请刷新后选择其他编号或位置。'},409);
    else if (message.includes('SAMPLE_SCOPE')) response=json({error:'样本来源、单位或位置不属于当前空间，操作已撤销。'},409);
    else if (message.includes('mutation_guard') || message.includes('value=1') || message.includes('INVITE_INVALID')) response=json({error:'记录已更新或邀请码已使用。请保留输入副本后刷新重试。'},409);
    else response=json({error:'服务暂时无法完成操作。原有资料未覆盖，请保留输入副本后重试。'},500);
  }
  const secured=new Response(response.body,response);
  for (const [key,value] of Object.entries(headers)) secured.headers.set(key,value);
  if (url.protocol==='https:') secured.headers.set('Strict-Transport-Security','max-age=31536000');
  return secured;
}};
