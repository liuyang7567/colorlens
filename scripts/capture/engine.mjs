import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import path from 'node:path';
import {HandsFreeRecorder} from './handsfree.mjs';
import {pcmWave,trimQuietEdges} from './audio.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export function subnet(address, mask) {
  const bytes = address.split('.').map(Number), masks = mask.split('.').map(Number);
  if (bytes.length !== 4 || masks.length !== 4 || [...bytes, ...masks].some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error('无效 IPv4 地址。');
  const bits = masks.map((value) => value.toString(2).padStart(8, '0')).join('');
  if (!/^1+0*$/.test(bits)) throw new Error('无效子网掩码。');
  const prefix = bits.indexOf('0');
  return bytes.map((value, index) => value & masks[index]).join('.') + '/' + (prefix < 0 ? 32 : prefix);
}
export function networks() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) => entries.filter((entry) => entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)).map((entry) => ({ name, address: entry.address, scope: subnet(entry.address, entry.netmask) })));
}
async function port() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const number = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return number;
}
async function udpPort() {
  const probe = createSocket('udp4');
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.bind(0, '127.0.0.1', resolve); });
  const number = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return number;
}
export function runProcess(filename, argumentsList, options = {}) {
  const child = spawn(filename, argumentsList, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  return child;
}
export class CaptureEngine {
  constructor({ runtime, state, allowFirewall, testMode = false }) {
    this.runtime = runtime;
    this.state = state;
    this.allowFirewall = testMode ? async () => null : allowFirewall;
    this.testMode = testMode;
    this.devices = new Map();
    this.owner = null;
    this.running = false;
    this.busy = false;
    this.polling = false;
    this.error = '';
    this.ownerExpires = 0;
    this.children = new Set();
    this.transition = 0;
    this.stopPromise = null;
    mkdirSync(state, { recursive: true });
    this.handsfree=new HandsFreeRecorder(this);
  }
  bind(claims) {
    if (this.owner && this.owner !== claims.user_id && (this.running || this.busy || this.devices.size)) throw new Error('本机助手已绑定另一个账号；请先停止并解除原账号绑定。');
    const previousExpiry=this.owner===claims.user_id?this.ownerExpires||0:0;
    this.owner = claims.user_id;
    // A delayed/shorter observer ticket cannot shorten another valid window's media lease.
    this.ownerExpires = Math.max(previousExpiry,claims.expires_at);
    this.handsfree.renew(claims);
    if (!this.devices.size) this.addDevice('小米 AI 眼镜');
  }
  addDevice(label) {
    if (!this.owner || this.devices.size >= 3) throw new Error('请先配对账号；本预览版每个本机助手最多 3 台设备。');
    const id = randomUUID(), name = String(label).trim();
    if (!name || name.length > 60) throw new Error('设备名称需为 1–60 字。');
    const device = { id, label: name, raw: 'input/' + randomBytes(12).toString('hex'), processed: 'preview/' + randomBytes(12).toString('hex'), password: randomBytes(24).toString('hex'), ready: false, online: false, error: '', transcoder: null };
    this.devices.set(id, device);
    if (this.running) this.saveConfiguration();
    return id;
  }
  async start(address) {
    if (this.busy || this.stopPromise) throw new Error('接收端正在切换状态，请稍候。');
    if (this.testMode && address !== '127.0.0.1') throw new Error('自动化测试只允许回环地址。');
    if (this.running) {
      if (this.address !== address) throw new Error('请先停止接收，再切换网络。');
      return;
    }
    if (this.firewall) throw new Error('上次临时防火墙清理尚未确认，请先再次停止接收以完成清理。');
    const choice = this.testMode && address === '127.0.0.1' ? { address, scope: '127.0.0.1/32' } : networks().find((item) => item.address === address);
    if (!choice || !this.owner || this.ownerExpires <= Date.now()) throw new Error('请确认账号配对有效，并选择当前电脑的局域网地址。');
    this.busy = true;
    const transition = ++this.transition;
    const current = () => { if (transition !== this.transition) throw new Error('接收已取消或配对已结束，请重新确认开始。'); };
    this.error = '';
    try {
      this.address = choice.address;
      this.scope = choice.scope;
      this.internalPassword = randomBytes(24).toString('hex');
      this.ports = { rtmp: this.testMode ? await port() : 1935, api: await port(), rtc: await port(), ice: await udpPort(), rtsp: await port() };
      current();
      this.sessionDirectory = path.join(this.state, randomUUID());
      mkdirSync(this.sessionDirectory);
      this.configurationPath = path.join(this.sessionDirectory, 'mediamtx.yml');
      for (const device of this.devices.values()) { device.raw = 'input/' + randomBytes(12).toString('hex'); device.processed = 'preview/' + randomBytes(12).toString('hex'); device.password = randomBytes(24).toString('hex'); }
      this.saveConfiguration();
      const media = runProcess(path.join(this.runtime, 'mediamtx.exe'), [this.configurationPath], { cwd: this.sessionDirectory });
      this.media = media;
      this.children.add(media);
      media.stdout.resume(); media.stderr.resume();
      media.on('error', () => { this.error = '媒体程序无法启动，请检查便携组件是否完整。'; });
      media.on('exit', () => {
        this.children.delete(media);
        if (this.media === media && this.running) { this.error = '媒体接收程序已退出，请重新启动接收。'; void this.stop(); }
      });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        current();
        try { await this.api('/v3/paths/list'); current(); break; }
        catch { current(); if (attempt === 49 || media.exitCode !== null) throw new Error('媒体端口启动失败，可能已被其他应用占用。'); await delay(150); }
      }
      current();
      this.firewall = await this.allowFirewall({ directory: this.sessionDirectory, program: path.join(this.runtime, 'mediamtx.exe'), address: this.address, scope: this.scope, port: this.ports.rtmp });
      current();
      this.running = true;
      this.startedAt = Date.now();
      this.timer = setInterval(() => { void this.tick(); }, 800);
    } catch (error) {
      await this.stop();
      throw error;
    } finally { this.busy = false; }
  }
  saveConfiguration() {
    if (!this.configurationPath) return;
    const permissions = [{ action: 'api' }];
    const paths = {};
    for (const device of this.devices.values()) {
      permissions.push({ action: 'read', path: device.raw }, { action: 'publish', path: device.processed }, { action: 'read', path: device.processed });
      paths[device.raw] = { source: 'publisher' }; paths[device.processed] = { source: 'publisher' };
    }
    const users = [{ user: 'bridge', pass: this.internalPassword, ips: ['127.0.0.1', this.address], permissions }, ...[...this.devices.values()].map((device) => ({ user: device.id, pass: device.password, ips: [this.scope], permissions: [{ action: 'publish', path: device.raw }] }))];
    writeFileSync(this.configurationPath, JSON.stringify({ logLevel: 'warn', logDestinations: ['stdout'], dumpPackets: false, authMethod: 'internal', authInternalUsers: users, api: true, apiAddress: `127.0.0.1:${this.ports.api}`, metrics: false, pprof: false, playback: false, rtsp: true, rtspAddress: `127.0.0.1:${this.ports.rtsp}`, rtspTransports: ['tcp'], rtmp: true, rtmpAddress: `${this.address}:${this.ports.rtmp}`, rtmpEncryption: 'no', hls: false, webrtc: true, webrtcAddress: `127.0.0.1:${this.ports.rtc}`, webrtcAllowOrigins: [], webrtcLocalUDPAddress: `127.0.0.1:${this.ports.ice}`, webrtcLocalTCPAddress: '', webrtcIPsFromInterfaces: false, webrtcAdditionalHosts: ['127.0.0.1'], webrtcICEServers2: [], srt: false, moq: false, pathDefaults: { record: false, overridePublisher: false }, paths }, null, 2));
  }
  authorization() { return 'Basic ' + Buffer.from('bridge:' + this.internalPassword).toString('base64'); }
  async api(endpoint) {
    const response = await fetch(`http://127.0.0.1:${this.ports.api}${endpoint}`, { headers: { Authorization: this.authorization() }, signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('媒体状态读取失败。');
    return response.json();
  }
  inputUrl(device) { return `rtmp://${this.address}:${this.ports.rtmp}/${device.raw}?user=bridge&pass=${this.internalPassword}`; }
  outputUrl(device) { return `rtsp://bridge:${this.internalPassword}@127.0.0.1:${this.ports.rtsp}/${device.processed}`; }
  async tick() {
    if (!this.running || this.polling) return;
    this.polling = true;
    const transition = this.transition;
    try {
      if (this.ownerExpires <= Date.now() || Date.now() - this.startedAt > 2 * 60 * 60 * 1000) { this.error = '采集授权或本次两小时接收时段已到期，请重新配对并启动。'; await this.stop(); return; }
      if (!this.testMode && !networks().some((item) => item.address === this.address && item.scope === this.scope)) { this.error = '电脑网络地址已变化，接收已停止；请选择新网络并复制新地址到官方 App。'; await this.stop(); return; }
      const paths = (await this.api('/v3/paths/list')).items;
      if (!this.running || transition !== this.transition) return;
      for (const device of this.devices.values()) {
        const input = paths.find((item) => item.name === device.raw), processed = paths.find((item) => item.name === device.processed);
        device.online = Boolean(input?.ready); device.ready = Boolean(processed?.ready);
        device.tracks = input?.tracks2 || []; device.bytes = input?.inboundBytes || 0;
        if (device.online && !device.transcoder && !device.error) {
          const child = runProcess(path.join(this.runtime, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rw_timeout', '15000000', '-i', this.inputUrl(device), '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-f', 'rtsp', '-rtsp_transport', 'tcp', this.outputUrl(device)]);
          device.transcoder = child; this.children.add(child); child.stdout.resume(); child.stderr.resume();
          child.on('error', () => { device.error = '音视频桥接组件无法启动。'; });
          child.on('exit', (code) => { this.children.delete(child); if (device.transcoder === child) { device.transcoder = null; if (this.running && device.online) device.error = '音视频转换中断，请停止官方 App 直播后重新启动接收。'; } });
        }
        if (!device.online) {
          device.error = '';
          if (device.transcoder) { const child = device.transcoder; device.transcoder = null; child.kill(); }
        }
      }
    } catch { if (this.running) this.error = '暂时无法读取接收状态；请检查连接或重新启动。'; }
    finally { this.polling = false; }
  }
  status() {
    return { running: this.running, busy: this.busy || Boolean(this.stopPromise), owner: this.owner, error: this.error, cleanupPending: Boolean(this.firewall)&&!this.running, address: this.address || null, scope: this.scope || null, devices: [...this.devices.values()].map((device) => ({ id: device.id, label: device.label, online: device.online, ready: device.ready, tracks: device.tracks || [], bytes: device.bytes || 0, error: device.error, publishUrl: this.running ? `rtmp://${this.address}:${this.ports.rtmp}/${device.raw}?user=${device.id}&pass=${device.password}` : null })), networks: this.testMode ? [{ name: '自动化测试 · 人工图案', address: '127.0.0.1', scope: '127.0.0.1/32' }] : networks(), offlineSpeech: existsSync(path.join(this.runtime, 'whisper', 'ggml-base-q5_1.bin')) };
  }
  async readOffer(deviceId, sdp) {
    const device = this.devices.get(deviceId);
    if (!this.running || !device?.ready) throw new Error('设备尚未收到可预览的直播，请先在官方 App 开始直播。');
    const base = `http://127.0.0.1:${this.ports.rtc}`;
    const response = await fetch(`${base}/${device.processed}/whep`, { method: 'POST', headers: { Authorization: this.authorization(), 'Content-Type': 'application/sdp' }, body: sdp, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('浏览器音视频协商失败，请重连预览。');
    const location = new URL(response.headers.get('location'), base);
    if (location.origin !== base || !location.pathname.startsWith(`/${device.processed}/whep/`)) throw new Error('媒体会话位置无效。');
    return { sdp: await response.text(), location: location.href };
  }
  async closeOffer(location) {
    if (this.running) await fetch(location, { method: 'DELETE', headers: { Authorization: this.authorization() }, signal: AbortSignal.timeout(2000) }).catch(() => {});
  }
  spawnAudio(device){return runProcess(path.join(this.runtime,'ffmpeg.exe'),['-hide_banner','-loglevel','error','-nostdin','-rtsp_transport','tcp','-timeout','10000000','-i',this.outputUrl(device),'-vn','-ac','1','-ar','16000','-f','s16le','pipe:1']);}
  async transcribe(deviceId, language, signal,duration=30) {
    if(this.handsfree.audio)throw new Error('免手动口令监听正在使用音轨，请先结束免手动记录。');
    if (this.speechBusy) throw new Error('已有一段语音正在处理，请等待或取消。');
    const device = this.devices.get(deviceId);
    if (!this.running || !device?.online || !device.tracks.some((track) => /Audio|Opus|AAC/i.test(track.codec))) throw new Error('眼镜当前没有可读取的音轨。');
    if (!['zh', 'en', 'auto'].includes(language)) throw new Error('转写语言无效。');
    if(![6,30].includes(duration))throw new Error('语音读取时长无效。');
    this.speechBusy = true;
    this.speechProgress={phase:'connecting',duration,capturedMs:0};
    const children = [];
    const stop = () => children.forEach((child) => child.kill());
    signal?.addEventListener('abort', stop, { once: true });
    try {
      let received=0;
      const pcm = await this.collect(path.join(this.runtime, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rw_timeout', '10000000', '-i', this.inputUrl(device), '-t', String(duration), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], 2 * 1048576, 45000, children, signal,undefined,chunk=>{received+=chunk.length;this.speechProgress={phase:'listening',duration,capturedMs:Math.min(duration*1000,Math.floor(received/32))};});
      const capturedAt=new Date().toISOString(),durationSeconds=pcm.length/32000;
      const speech=trimQuietEdges(pcm);if(!speech)throw new Error('未检测到清晰语音，请等收到音轨提示后再说话。');const wav=pcmWave(speech);
      this.speechProgress={phase:'recognizing',duration,capturedMs:duration*1000};
      const transcript = await this.collect(path.join(this.runtime, 'whisper', 'Release', 'whisper-cli.exe'), ['-m', path.join(this.runtime, 'whisper', 'ggml-base-q5_1.bin'), '-f', '-', '-of', 'memory', '-l', language, '-nt', '-np', '-ng', '-t', '4'], 65536, 180000, children, signal, wav);
      const text = transcript.toString('utf8').trim();
      if (!text || text.length > 12000) throw new Error('未识别到可用语音，请检查音量并重试。');
      return {text,deviceId:device.id,deviceLabel:device.label,language,durationSeconds,requestedDuration:duration,source:'眼镜音轨 · '+device.label+' · 约 '+durationSeconds.toFixed(1)+' 秒本机离线转写',capturedAt,needsReview:true};
    } finally { stop(); this.speechBusy = false;this.speechProgress={phase:'idle'}; signal?.removeEventListener('abort', stop); }
  }
  async collect(filename, argumentsList, maximum, timeout, children, signal, input,onData) {
    if (signal?.aborted) throw new Error('语音转写已取消。');
    const child = runProcess(filename, argumentsList); children.push(child); this.children.add(child);
    return new Promise((resolve, reject) => {
      const output = []; let length = 0; let exceeded = false;
      const timer = setTimeout(() => { exceeded = true; child.kill(); }, timeout);
      child.stdout.on('data', (chunk) => { length += chunk.length; if (length > maximum) { exceeded = true; child.kill(); } else {output.push(chunk);onData?.(chunk);} });
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timer); this.children.delete(child); reject(new Error('离线语音组件无法启动，请检查安装文件。')); });
      child.on('close', (code) => { clearTimeout(timer); this.children.delete(child); if (signal?.aborted) reject(new Error('语音转写已取消。')); else if (code !== 0 || exceeded) reject(new Error('本机音频读取或转写失败/超时，请检查音轨后重试。')); else resolve(Buffer.concat(output)); });
      child.stdin.end(input);
    });
  }
  stop() {
    this.transition++;
    this.running = false;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.finishStop().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
  async finishStop() {
    clearInterval(this.timer);
    let signalFailed = false;
    try { await this.handsfree.stop('本机接收已停止。'); }
    catch { this.error = '记录停止时无法写入状态；已停止媒体处理，请保留本机资料检查磁盘。'; }
    try { if (this.sessionDirectory) writeFileSync(path.join(this.sessionDirectory, 'stop.signal'), 'stop'); }
    catch { signalFailed = true; this.error = '媒体已停止，但本机会话目录不可写；请检查磁盘，必要时在启动器点“停止并退出”。'; }
    for (const device of this.devices.values()) { device.ready = false; device.online = false; device.error = ''; device.transcoder = null; }
    for (const child of this.children) child.kill();
    this.children.clear(); this.media = null;
    await delay(100);
    if (this.firewall?.statePath) {
      let removed = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try { removed = JSON.parse(readFileSync(this.firewall.statePath, 'utf8').replace(/^\uFEFF/, '')).state === 'removed'; } catch {}
        if (removed) break;
        await delay(250);
      }
      if (!removed) this.error = signalFailed ? '媒体已停止，但无法写入临时放行的清理标记；请在启动器点“停止并退出”，等待清理后再重新打开。' : '媒体已停止，但尚未确认临时防火墙规则已移除，请在助手中查看清理状态。';
      else this.firewall = null;
    }
  }
  async unbind() {
    await this.stop(); this.owner = null; this.ownerExpires = 0; this.devices.clear();
  }
}
