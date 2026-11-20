import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const quote = (value) => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
export async function allowFirewall({ directory, program, address, scope, port }) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'firewall.ps1');
  const argumentsList = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-StateDirectory', directory, '-Program', program, '-Address', address, '-Scope', scope, '-Port', String(port), '-OwnerProcess', String(process.pid)];
  const command = `$started=(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks; Start-Process -FilePath (Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList (${literal(argumentsList.map(quote).join(' '))}+' -OwnerStarted '+$started) -Verb RunAs -WindowStyle Hidden -ErrorAction Stop`;
  const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
  let failed = false;
  child.on('error', () => { failed = true; }); child.on('exit', (code) => { if (code !== 0) failed = true; });
  const statePath = path.join(directory, 'firewall-state.json');
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (existsSync(statePath)) {
      const status = JSON.parse(readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
      if (status.state === 'active') return { statePath, rule: status.rule };
      if (status.state === 'error') throw new Error('临时防火墙配置失败，未启动接收；请检查管理员确认或网络状态。');
    }
    if (failed) throw new Error('管理员确认未完成或已取消；接收端已停止，不会关闭系统防火墙。');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('等待管理员确认超时；接收端已停止。');
}
