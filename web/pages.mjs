export function mountWorkspacePages(){
  const main=document.querySelector('main');
  function convert(id,title){
    const original=document.getElementById(id),page=document.createElement('section');
    page.id=id;page.className='workspace-page';page.hidden=true;page.tabIndex=-1;
    page.append(...original.childNodes);original.replaceWith(page);main.append(page);
    const heading=page.querySelector('.dialog-header h2'),replacement=document.createElement('h1');
    replacement.id=id+'-heading';replacement.textContent=title;heading.replaceWith(replacement);page.setAttribute('aria-labelledby',replacement.id);
    const back=document.createElement('a');back.href='#notebook';back.className='button secondary';back.textContent='返回我的实验';page.querySelector('.close-dialog').replaceWith(back);
    return page;
  }
  convert('records-dialog','分析快照');
  const backup=convert('note-backup-dialog','数据与备份');
  const usage=document.createElement('div');usage.className='cloud-storage-summary';
  usage.innerHTML='<section><h2>当前账号 · 原始附件</h2><p id="storage-files-used">正在读取…</p><meter id="storage-files-meter" min="0" max="52428800" value="0" aria-label="当前账号附件用量"></meter></section><section><h2>当前账号 · 文字与历史</h2><p id="storage-documents-used">正在读取…</p><meter id="storage-documents-meter" min="0" max="10485760" value="0" aria-label="当前账号文字与历史用量"></meter></section><section><h2>备份与使用方式</h2><p>日常直接在线查看；仅在主动导出时下载 ZIP。单个附件最大 20 MB。</p></section>';
  backup.querySelector('.backup-actions').before(usage);
  const guide=convert('notebook-guide-dialog','使用指南'),analysis=document.getElementById('guide-dialog'),chapter=document.createElement('section');
  chapter.id='guide-dialog';chapter.className='guide-chapter';chapter.append(...analysis.childNodes);analysis.replaceWith(chapter);chapter.querySelector('.close-dialog').remove();guide.append(chapter);
  const step=chapter.querySelector('.guide-steps li:last-child p');step.textContent='保存至自己的云端实验记录。分析快照可以直接在线查看；需要离线备份时再主动下载 ZIP，日常阅读不需要先下载文件。';
  const samples=document.createElement('section');samples.className='guide-chapter';
  samples.innerHTML='<h2>样本台账、分装与冻存位置</h2><p>“样本与冻存”默认打开自己的私有空间。也可在已经加入的团队登记样本，需明确确认；负责人/编辑者可修改，评阅者/只读成员仅查看。团队样本不公开你的私人实验或其他空间样本。</p><p>先登记冰箱/库位、架/层和固定尺寸冻存盒，再用 A1 等坐标登记样本，孔位不能覆盖。保存条件是人工声明，不是实时温度。唯一编号和单位保存后固定，支/份只能填整数，其他单位最多六位小数，不自动换算单位或相加不同单位。</p><p>领用、补入、盘点校正、资料修订和移库均需原因并追加流水。分装会原子扣除母样本数量、创建同单位子样本并保留谱系；余量为零不自动释放母管孔位。仅零余量可归档并释放位置，历史不会删除。并发修订、占位或配额失败不部分扣库存。</p><p>实验编辑器的“关联样本”建立只属于你的双向关联，不改变实验原文/完成锁定，也不让其他团队成员看到你的实验标题或附件。需要备份时主动导出单样本 JSON；个人实验 ZIP 不包含样本空间或流水。试剂批次和采购审批在独立的“库存与采购”页面；当前无全空间导入恢复、条码硬件、离线或合规认证。</p>';
  guide.append(samples);
  const inventory=document.createElement('section');inventory.className='guide-chapter';
  inventory.innerHTML='<h2>库存批次与团队采购</h2><p>“库存与采购”默认显示自己的批次。团队空间内负责人/编辑者可登记批次、操作余量；评阅者/只读成员仅查看。登记团队批次或提交采购申请前须明确授权，全团队成员可见该空间的批次、申请、金额与流水。</p><p>编号、厂家、货号、批号和单位保存后固定；不同单位不自动换算。领用、补入、盘点校正、资料修订、处置均需原因并追加流水。到期日按北京时间判断；已过期批次不能普通领用，可以登记处置。低库存与到期提醒只在页面显示，不发送通知。仅零余量可归档，历史保留。</p><p>团队编辑者提交单品采购申请，负责人不能审批自己的申请。批准后可分次收货到同空间、同单位且身份匹配的批次；填写收货单号，同一申请的同一单号和内容重复提交不会重复入库。并发、配额或权限失败整笔回滚。负责人可关闭部分收货申请，不撤销已入库余量。当前金额为人民币预估总额，不是付款、财务凭证或向供应商下单。</p><p>仅主动点击单批次/单申请 JSON 导出时下载；个人实验 ZIP 不包含库存采购。尚无全空间恢复、多级审批、供应商支付或自动财务对账。</p>';
  guide.append(inventory);
  const equipment=document.createElement('section');equipment.className='guide-chapter';
  equipment.innerHTML='<h2>设备预约与人工使用记录</h2><p>“设备与预约”默认打开私人空间。自己的设备或团队负责人才可登记设备、修改资料、切换维护/可用状态或停用；团队编辑者可预约，评阅者/只读成员仅查看。团队设备、预约用途与使用记录对全团队可见。</p><p>预约使用本机时区输入，提交后按带时区的时间保存；单次 1 分钟至 7 天。服务器拒绝同一设备的重叠有效预约，相邻时段可以预约；维护或停用设备不能新增预约。存在尚未结束的有效预约时，必须先明确取消，不能静默切换维护或停用。</p><p>本人或负责人可填写原因取消预约；到预约开始后，也可填写实际开始/结束时间与使用说明，追加人工使用记录。修改需通过当前权限与版本检查，不覆盖既有历史。人工登记不代表设备遥测、仪器原始测量、真实计费或可靠出勤证明。</p><p>页面显示近期动态；只有主动导出设备 JSON 才下载完整记录。个人实验 ZIP 不包含设备预约，尚无硬件连接、自动计费、提醒邮件或全空间恢复。</p>';
  guide.append(equipment);
  const teams=document.createElement('section');teams.className='guide-chapter';
  teams.innerHTML='<h2>团队项目与逐版评阅</h2><p>在“团队与评阅”创建团队和项目，按已验证邮箱邀请编辑者、评阅者或只读成员。邀请在对方登录后的团队页面出现，7 天有效，本阶段不发送邀请邮件；新用户仍需完成实验室邀请码注册。</p><p>私人实验不会自动公开。编辑者选择自己的已保存笔记，预览完整文字、勾选授权后才提交给整个团队。不包含原附件、正文图片、私人修改历史、原生分析快照和 AI 草稿；主动粘贴在正文或结果中的摘要文字仍会包含。</p><p>评论与评阅按提交版本保留，不能评阅自己的稿件。修改私人原件不更新团队稿，只有主动发布新版才更新，并重新变为待评阅。原提交者或负责人可填说明撤回；团队不再显示正文版本，但已复制内容不能收回。角色和移除操作由服务端逐次校验，平台管理员不自动获得私人团队访问权。</p><p>只有主动点击“导出此提交 JSON”才下载，包含这份提交的文字版本和动态；不是全团队备份，现有个人实验 ZIP 也不包含团队关系。本阶段按约定仅提供内部审核留痕，记录账号、时间、版本及意见；不是真实电子签署、第三方实名认证或合规认证。当前也不是实时共同编辑或共享附件。</p>';
  guide.append(teams);
  const templates=document.createElement('section');templates.className='guide-chapter';
  templates.innerHTML='<h2>实验模板与版本来源</h2><p>在“实验模板”查看原创 qPCR、ELISA、BCA 记录框架，或新建自己的模板。可编辑五个记录栏目、文本/数值/日期/下拉/勾选字段与检查单。内置模板只能另存个人副本，不替代实际试剂盒说明书。</p><p>点击“使用模板新建”后，记录保存当时的模板版本；以后修改模板不会更改旧实验。草稿允许必填项留空，完成记录前必须补齐；再次实验保留模板版本，但清空原字段值与勾选。个人模板仅自己可见，模板编辑需主动保存。</p><p>单个模板可主动导出/导入 JSON。已使用的模板定义、字段和检查状态随实验 ZIP 保存，导入建立标记来源的新副本，不覆盖原记录。实验 ZIP 不包含未使用的模板库及其全部历史。检查单不是电子签名或外部认证。</p>';
  guide.append(templates);
  const qpcr=document.createElement('section');qpcr.className='guide-chapter';
  qpcr.innerHTML='<h2>qPCR / RT-qPCR 表达量分析</h2><ol class="guide-steps"><li><h3>选择输入版本与方法</h3><p>在“分析工具”的方法选择中选 qPCR。快捷版适合少量样本；批量版可导入 CSV / TSV 或粘贴带英文表头的 Excel 表格。选择已有 ΔCt 或原始 Ct，ΔCt 定义为目标 Ct−内参 Ct。切换数值类型会清空旧数值，避免误算。</p></li><li><h3>根据实验前提选择公式</h3><p>无对照时用 2^(-ΔCt)，仅为内参归一化相对量；有对照时用 2^(-ΔΔCt)。等效率校正需要目标与内参具有相同、已验证的效率；不同效率用 Pfaffl，必须提供两种原始 Ct 和各自效率。标准曲线法需要至少三个不同的已知正数量标准品及 Ct，输出与标准品同单位的模板量，不能只靠 ΔCt 推算绝对拷贝数。</p></li><li><h3>正确区分样本与技术孔</h3><p>批量 ΔCt 必需表头为 sample_id,group,delta_ct；原始 Ct 为 sample_id,group,ct_target,ct_reference，标准曲线未知样本不需 ct_reference。可加 target 列；配对分析加 pair_id。相同 target + sample_id 先平均技术行，再按样本 ID 等权统计。独立样本使用不同 ID；仅技术重复不要声明为生物重复。效率校正 / Pfaffl 本版请逐个目标基因分析。</p></li><li><h3>计算、保存与复核</h3><p>填写内参、对照或标准品，确认方法前提后计算。结果包括 ΔCt、适用时的 ΔΔCt、表达倍数、log₂FC 和分组描述统计；不产生 p 值或显著性。标准曲线显示拟合参数、效率与外推提示。保存后在“分析快照”在线查看，只有主动导出才下载 ZIP。需要 DeepSeek 解读时，先在实验记录中选择快照、预览发送内容并授权。</p></li></ol><p class="cloud-warning">基数 2 需要目标和内参扩增效率接近 100% 且相近。未扩增、Undetermined、空白或 Ct=0 不能填作有效 Ct。软件不检查原始扩增 / 熔解曲线、NTC、内参稳定性及检出限；输出不是临床结论。</p>';
  guide.append(qpcr);
  const chart=document.createElement('p');chart.textContent='结果图按目标基因切换，每点为合并技术行后的一个样本 ID，横线为算术均值，误差线为样本 SD；n<2 不显示 SD。不是 SEM、置信区间或显著性检验。SVG / PNG 仅在主动点击图形导出时下载，查看记录不会自动下载。';qpcr.append(chart);
  const elisa=document.createElement('section');elisa.className='guide-chapter';
  elisa.innerHTML='<h2>ELISA 标准曲线与浓度</h2><p>在“分析工具”选择 IL-6、IL-10、TNF-α、IL-1β 或 IFN-γ，再把“ELISA 分析方式”切换为本批次标准曲线定量。原有“仅整理 OD”仍保留。输入实际标准品、样本读数、浓度单位及稀释倍数；未稀释填 1。</p><p>4PL 至少 6 个不同浓度、5PL 至少 8 个，其中至多一个为零标准；blank 不自动算零标准。参考 OD 须全填或全留空；只有未在仪器端扣过空白时才勾选软件扣除，防止重复校正。各浓度均值等权拟合，样本先平均技术孔 OD，再反算上板浓度并乘稀释倍数。</p><p>范围外或无法反算的浓度留空，不填零、不外推。曲线可主动导出 SVG；保存后能在线查看、载入工具复核、导出含原读数和参数的 ZIP。可主动把已保存摘要追加到原实验结果，保留快照编号；不会覆盖原文字或绕过完成锁定。DeepSeek 仍需预览并授权，不替你计算浓度。</p><p class="cloud-warning">标准区间不等于经过验证的定量限。R²、残差或回收率不自动判定实验合格，OD 技术重复的 SD 不是浓度不确定度；软件未验证真实试剂盒或临床用途。</p>';
  guide.append(elisa);
  const multi=document.createElement('section');multi.className='guide-chapter';
  multi.innerHTML='<h2>qPCR 多内参原始 Ct 长表</h2><p>在 qPCR 的输入类型选择“多内参原始 Ct”。仅使用批量版；填写 2–5 个已验证内参及各自效率，原始表头为 sample_id,group,gene,ct，可选 pair_id,plate_id,well。每个样本必须有全部目标及所选内参，缺失/未扩增不自动插补。基因名区分大小写。</p><p>先按样本和基因分别平均技术孔 Ct，再对各内参的相对量等权取几何均值；不是对 Ct 本身取几何均值，也不按内参孔数加权。普通 ΔCt/ΔΔCt 使用模型效率 100%；等效率法的每个内参与目标效率相同；不同效率选择 Pfaffl 形式的多内参推广并逐个目标分析。该模式不把传统 ΔCt/ΔΔCt 或单一内参效率用于不同效率结果。</p><p>内参配置、逐基因技术孔数和 Ct 均值可在结果与在线快照核对，主动 ZIP 包含原始长表、配置和汇总。图形每点仍是一个样本 ID，不因内参数量增加 n。可填写板次/孔位作追溯，但不自动做跨板校准、内参稳定性评估、效率误差传播或显著性检验。</p>';
  guide.append(multi);
  const continuity=document.createElement('section');continuity.className='guide-chapter';
  continuity.innerHTML='<h2>离线、ELN、实时协作与服务器恢复</h2><p>“数据与备份”可进入加密离线工作区。先在同一浏览器联网登录、另设离线密码，主动选择私人记录和可选附件缓存；之后可断网重开，编辑草稿或新建记录，联网后用原账号同步。不同字段自动合并，同字段冲突需明确选择；忘记密码或清理浏览器会丢失未同步资料，请主动导出 .clvault 加密副本。网页版与 Windows 窗口配置独立，需各自首次启用。</p><p>同页支持单根目录、RO-Crate 元数据、Dataset/File 与文件哈希的 .eln 导出及基础导入；不是把镜析 ZIP 改扩展名。导入先本机校验并预览，再授权上传为新副本。外部 HTML 仅当文字，不加载外链；自定义语义与其他厂商原生历史/权限不保证无损转换。</p><p>“实时协作”从空白创建面向整个团队的文字文档，约 2.5 秒轮询更新、按字段合并与冲突确认、保留版本。它不改变私人笔记，也不会让“团队与评阅”的冻结稿自动变化；不是逐字符 CRDT，不共享原附件或原生分析，不离线排队。</p><p>完整服务器恢复由持有服务器权限的所有者运行加密备份工具，包含账号、原始附件、全部业务表、运行版本与认证配置；恢复先校验到全新的隔离库，不在网页一键覆盖生产。它不同于个人 ZIP 或单实体 JSON，不能恢复尚未上传的本机草稿。正式切换前仍需复核成员/分享/邀请权限，应用不会自动回滚生产、切换域名或冒充合规认证。</p>';
  guide.append(continuity);
  return info=>{
    for(const [kind,key,maximum,label] of [['files','file_bytes',52428800,'50'],['documents','doc_bytes',10485760,'10']]){
      document.getElementById('storage-'+kind+'-used').textContent=`已用 ${(info[key]/1048576).toFixed(2)} / ${label} MB`;
      document.getElementById('storage-'+kind+'-meter').value=Math.min(info[key],maximum);
    }
  };
}
