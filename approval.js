/*
 * HarnessMate DSH 插件 —— 审批载荷元数据
 *
 * 目的：把 DSH 的 approval/request 翻译成平台能落库、能审计、能校验的东西：
 *   action        结构化动作名（exec.shell / fs.delete / message.send ...）
 *   risk_level    L0=0 .. L3=3（未命中一律 3，fail-closed）
 *   payload       真正决定"危险程度"的字段（不放全文）
 *   payload_digest sha256(规范化 JSON)，必须与平台 Python 侧逐字节一致
 *   title         含参数的人话摘要（不要出现"需要授权的操作"这类空话）
 *
 * digest 规则（与 api/internal/service/approval_service.py 一致）：
 *   raw = 键排序 + 不转义非 ASCII + 分隔符不带空格 的 JSON
 *   digest = sha256(raw).hexdigest()
 *
 * 固定测试向量：
 *   payload {"cmd":"ls -la","cwd":"/tmp"} -> da3de683d7237df52a3a6936f7145fd049b48dee587091808b540b5d6de16991
 */
import { createHash } from 'node:crypto';

/** 规范化 JSON：键排序、无多余空格、保留非 ASCII 原字符 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

/** payload 的 sha256 hex（与平台一致） */
export function computePayloadDigest(payload) {
  const raw = canonicalJson(payload ?? {});
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** 取参数对象：DSH 各版本字段名不同，按优先级兜底 */
function pickArgs(request) {
  const candidates = [request?.args, request?.input, request?.params, request?.parameters, request?.toolArgs];
  for (const c of candidates) {
    if (c && typeof c === 'object' && !Array.isArray(c)) return c;
  }
  return {};
}

function pickToolName(request) {
  return String(
    request?.toolName ??
      request?.tool?.name ??
      request?.tool ??
      request?.name ??
      request?.callId ??
      '',
  ).trim();
}

function shortText(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

const sha256Hex = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');

/**
 * 工具名 → { action, risk_level }
 * 未命中返回 tool.<原样工具名> + L3（fail-closed）
 */
export function resolveAction(toolName) {
  const name = String(toolName || '').toLowerCase();
  const rules = [
    [/(^|[._-])(shell|terminal|bash|exec|command)([._-]|$)/, 'exec.shell', 2],
    [/(^|[._-])(delete|remove|rm|unlink|trash)([._-]|$)/, 'fs.delete', 3],
    [/(^|[._-])(write|edit|create|patch|mkdir|append)([._-]|$)/, 'fs.write', 1],
    [/(^|[._-])(install|package|npm|pip|yarn|pnpm)([._-]|$)/, 'package.install', 2],
    [/(^|[._-])(send|message|reply|post|publish|email)([._-]|$)/, 'message.send', 3],
    [/(^|[._-])(fetch|http|request|curl|wget|browse)([._-]|$)/, 'http.request', 2],
    [/(^|[._-])(deploy|release|publish_production)([._-]|$)/, 'deploy.production', 3],
    [/(^|[._-])(read|list|cat|ls|grep|search|view)([._-]|$)/, 'fs.read', 0],
  ];
  for (const [re, action, risk] of rules) {
    if (re.test(name)) return { action, risk_level: risk };
  }
  return { action: name ? `tool.${name}` : 'tool.unknown', risk_level: 3 };
}

/** 按 action 抽取"决定危险程度"的字段 */
export function buildPayload(action, args) {
  const a = args || {};
  const path = a.path ?? a.file ?? a.filePath ?? a.target ?? '';
  switch (action) {
    case 'exec.shell':
      return { cmd: String(a.command ?? a.cmd ?? a.script ?? ''), cwd: String(a.cwd ?? a.workdir ?? '') };
    case 'fs.delete':
      return { path: String(path), recursive: Boolean(a.recursive) };
    case 'fs.write':
      return { path: String(path), bytes: Number(a.bytes ?? a.size ?? 0) };
    case 'package.install':
      return {
        manager: String(a.manager ?? a.packageManager ?? ''),
        packages: Array.isArray(a.packages) ? a.packages : [String(a.package ?? a.name ?? '')],
      };
    case 'message.send':
      return {
        platform: String(a.platform ?? a.channel ?? ''),
        to: String(a.to ?? a.chatId ?? a.target ?? ''),
        text_digest: sha256Hex(a.text ?? a.content ?? a.message ?? ''),
      };
    case 'http.request':
      return { method: String(a.method ?? 'GET').toUpperCase(), url_digest: sha256Hex(a.url ?? '') };
    default:
      return { tool: action, args_digest: sha256Hex(canonicalJson(a)) };
  }
}

/** 生成含参数的人话标题 */
export function buildTitle(action, payload, fallback) {
  switch (action) {
    case 'exec.shell':
      return payload.cmd ? `执行命令 ${shortText(payload.cmd, 80)}` : '执行命令';
    case 'fs.delete':
      return payload.path ? `删除 ${payload.path}` : '删除文件';
    case 'fs.write':
      return payload.path ? `写入 ${payload.path}` : '写入文件';
    case 'package.install':
      return `安装依赖 ${shortText((payload.packages || []).join(' '), 60)}`.trim();
    case 'message.send':
      return `向 ${payload.to || payload.platform || '目标会话'} 发送消息`;
    case 'http.request':
      return `发起 ${payload.method || 'HTTP'} 请求`;
    default:
      return fallback || `执行 ${action}`;
  }
}

/**
 * 主入口：把 DSH 的 approval/request 变成平台需要的审批元数据
 * @returns {{action:string, risk_level:number, payload:object, payload_digest:string, title:string}}
 */
export function buildApprovalMeta(request) {
  const toolName = pickToolName(request);
  const args = pickArgs(request);
  const { action, risk_level } = resolveAction(toolName);
  const payload = buildPayload(action, args);
  const payload_digest = computePayloadDigest(payload);
  const fallbackTitle = request?.title ?? toolName;
  const title = buildTitle(action, payload, fallbackTitle);
  return { action, risk_level, payload, payload_digest, title, tool: toolName };
}
