import { DEFAULT_BACKEND_URL, DEFAULT_WS_URL } from '@ai-browser-agent/shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function sendMessage<T>(message: object): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

interface ServerConfig {
  llmBaseUrl?: string;
  llmModel?: string;
  maxSteps?: number;
  hasApiKey?: boolean;
}

async function load(): Promise<void> {
  const s = await chrome.storage.local.get([
    'backendUrl',
    'wsUrl',
    'autorunEnabled',
    'autorunWhitelist',
    'authToken',
    'allowEvaluate',
    'allowPrivateNetwork',
    'voiceEnabled',
    'voiceLang',
    'voiceRefine',
  ]);
  $<HTMLInputElement>('backendUrl').value = (s.backendUrl as string) ?? DEFAULT_BACKEND_URL;
  $<HTMLInputElement>('wsUrl').value = (s.wsUrl as string) ?? DEFAULT_WS_URL;
  $<HTMLInputElement>('autorunEnabled').checked = Boolean(s.autorunEnabled);
  $<HTMLTextAreaElement>('autorunWhitelist').value = Array.isArray(s.autorunWhitelist)
    ? (s.autorunWhitelist as string[]).join('\n')
    : '';
  $<HTMLInputElement>('authToken').value = (s.authToken as string) ?? '';
  $<HTMLInputElement>('allowEvaluate').checked = s.allowEvaluate !== false;
  $<HTMLInputElement>('allowPrivateNetwork').checked = Boolean(s.allowPrivateNetwork);
  $<HTMLInputElement>('voiceEnabled').checked = s.voiceEnabled !== false;
  $<HTMLInputElement>('voiceRefine').checked = s.voiceRefine !== false;
  $<HTMLInputElement>('voiceLang').value = (s.voiceLang as string) ?? 'zh-CN';

  try {
    const { config } = await sendMessage<{ config?: ServerConfig; error?: string }>({
      type: 'GET_SERVER_CONFIG',
    });
    if (config) {
      $<HTMLInputElement>('llmBaseUrl').value = config.llmBaseUrl ?? '';
      $<HTMLInputElement>('llmModel').value = config.llmModel ?? '';
      $<HTMLInputElement>('maxSteps').value = config.maxSteps ? String(config.maxSteps) : '';
      if (config.hasApiKey) $<HTMLInputElement>('llmApiKey').placeholder = '已设置（留空保持不变）';
    }
  } catch {
    /* backend offline; local settings still editable */
  }
}

async function save(): Promise<void> {
  const result = $('saveResult');
  result.textContent = '保存中…';
  result.className = 'hint';

  const backendUrl = $<HTMLInputElement>('backendUrl').value.trim();
  const wsUrl = $<HTMLInputElement>('wsUrl').value.trim();
  const autorunEnabled = $<HTMLInputElement>('autorunEnabled').checked;
  const autorunWhitelist = $<HTMLTextAreaElement>('autorunWhitelist')
    .value.split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const authToken = $<HTMLInputElement>('authToken').value.trim();
  const allowEvaluate = $<HTMLInputElement>('allowEvaluate').checked;
  const allowPrivateNetwork = $<HTMLInputElement>('allowPrivateNetwork').checked;
  const voiceEnabled = $<HTMLInputElement>('voiceEnabled').checked;
  const voiceRefine = $<HTMLInputElement>('voiceRefine').checked;
  const voiceLang = $<HTMLInputElement>('voiceLang').value.trim() || 'zh-CN';
  await chrome.storage.local.set({
    backendUrl,
    wsUrl,
    autorunEnabled,
    autorunWhitelist,
    authToken,
    allowEvaluate,
    allowPrivateNetwork,
    voiceEnabled,
    voiceRefine,
    voiceLang,
  });

  const serverPatch: Record<string, unknown> = {
    llmBaseUrl: $<HTMLInputElement>('llmBaseUrl').value.trim(),
    llmModel: $<HTMLInputElement>('llmModel').value.trim(),
  };
  const apiKey = $<HTMLInputElement>('llmApiKey').value;
  if (apiKey) serverPatch.llmApiKey = apiKey;
  const maxSteps = $<HTMLInputElement>('maxSteps').value.trim();
  if (maxSteps) serverPatch.maxSteps = Number(maxSteps);

  try {
    await sendMessage({ type: 'SET_SERVER_CONFIG', config: serverPatch });
    result.textContent = '已保存';
    result.className = 'hint ok';
    $<HTMLInputElement>('llmApiKey').value = '';
  } catch (err) {
    result.textContent = `本地已保存，但后端配置失败：${err instanceof Error ? err.message : String(err)}`;
    result.className = 'hint err';
  }
}

async function test(): Promise<void> {
  const res = $('testResult');
  res.textContent = '测试中…';
  res.className = 'hint';
  const backendUrl = $<HTMLInputElement>('backendUrl').value.trim() || DEFAULT_BACKEND_URL;
  try {
    const r = await fetch(`${backendUrl}/health`);
    const data = (await r.json()) as { status?: string; extensionConnected?: boolean };
    res.textContent = `连接正常（status=${data.status}, 扩展连接=${data.extensionConnected ? '是' : '否'}）`;
    res.className = 'hint ok';
  } catch (err) {
    res.textContent = `连接失败：${err instanceof Error ? err.message : String(err)}`;
    res.className = 'hint err';
  }
}

async function exportBundle(): Promise<void> {
  const res = $('debugResult');
  res.textContent = '生成中…';
  res.className = 'hint';
  try {
    const bundle = await sendMessage<{ error?: string } & Record<string, unknown>>({
      type: 'GET_DEBUG_BUNDLE',
    });
    if (bundle?.error) throw new Error(bundle.error);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-agent-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    res.textContent = '已导出调试包';
    res.className = 'hint ok';
  } catch (err) {
    res.textContent = `导出失败：${err instanceof Error ? err.message : String(err)}`;
    res.className = 'hint err';
  }
}

async function clearLogs(): Promise<void> {
  const res = $('debugResult');
  try {
    await sendMessage({ type: 'CLEAR_DEBUG_LOGS' });
    res.textContent = '已清空日志';
    res.className = 'hint ok';
  } catch (err) {
    res.textContent = `清空失败：${err instanceof Error ? err.message : String(err)}`;
    res.className = 'hint err';
  }
}

$('saveBtn').addEventListener('click', save);
$('testBtn').addEventListener('click', test);
$('exportBtn').addEventListener('click', exportBundle);
$('clearLogsBtn').addEventListener('click', clearLogs);
load();
