/**
 * 通知服务 — 对应原版 NotificationService.php
 * SMTP: 用 Workers socket (cloudflare:sockets) 实现，支持 SSL/STARTTLS
 * Telegram / Webhook: fetch 实现
 */

import { fmtTime } from './store';

export type NotifyConfig = Record<string, string>;

/** 东八区当前时间（通知正文时间戳） */
function nowText(): string {
  return fmtTime(Math.floor(Date.now() / 1000));
}

// ==================== SMTP ====================

interface SmtpResponse {
  code: number;
  message: string;
}

function parseSmtpResponse(data: string): SmtpResponse[] {
  const lines = data.split('\r\n').filter((l) => l.length);
  const out: SmtpResponse[] = [];
  for (const line of lines) {
    const code = parseInt(line.slice(0, 3), 10);
    out.push({ code, message: line });
  }
  return out;
}

async function smtpTalk(socket: any, send: string, expectedCodes: number[]): Promise<SmtpResponse[]> {
  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode(send));
  writer.releaseLock();

  const reader = socket.readable.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error('SMTP 连接被关闭');
    buf += decoder.decode(value, { stream: true });
    // 响应以 CRLF.CRLF 或带空格续行的结束；简化：等最后一行以 \r\n 结尾且为 3 位码+空格
    const lines = buf.split('\r\n');
    if (lines.length >= 2 && lines[lines.length - 2].length > 0) {
      const last = lines[lines.length - 2];
      if (/^\d{3} /.test(last)) {
        reader.releaseLock();
        const responses = parseSmtpResponse(buf);
        const lastCode = responses[responses.length - 1].code;
        if (!expectedCodes.includes(lastCode)) {
          throw new Error(`SMTP 错误: ${last}`);
        }
        return responses;
      }
    }
  }
}

function base64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

export async function sendMail(
  cfg: NotifyConfig,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<true | string> {
  const host = cfg['notify_host'] || '';
  const port = parseInt(cfg['notify_port'] || '465', 10);
  const username = cfg['notify_username'] || '';
  const password = cfg['notify_password'] || '';
  const secure = cfg['notify_secure'] || 'ssl'; // ssl | tls | '' 

  if (!host || !username || !password || !to) return 'SMTP 配置不完整';

  try {
    // connect() 仅在 socket 允许时可用（本地 dev 用 connect 兼容层）
    const { connect } = await import('cloudflare:sockets');
    const tls = secure === 'ssl' || port === 465;

    const socket = connect(
      { hostname: host, port },
      (tls ? { secureTransport: 'on' } : undefined) as any,
    );
    const reader = socket.readable.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readResponse = async (): Promise<SmtpResponse[]> => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SMTP 连接被关闭');
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\r\n');
        if (lines.length >= 2 && /^\d{3} /.test(lines[lines.length - 2] || '')) {
          const responses = parseSmtpResponse(buf);
          buf = '';
          reader.releaseLock();
          return responses;
        }
      }
    };
    const talk = async (send: string, expected: number[]): Promise<SmtpResponse[]> => {
      const w = socket.writable.getWriter();
      await w.write(new TextEncoder().encode(send));
      w.releaseLock();
      const responses = await readResponse();
      const code = responses[responses.length - 1].code;
      if (!expected.includes(code)) throw new Error(`SMTP 错误: ${responses[responses.length - 1].message}`);
      return responses;
    };

    // 220 欢迎
    let resp = await readResponse();
    if (resp[0].code !== 220) throw new Error(`SMTP 连接失败: ${resp[0].message}`);

    const ehlo = `EHLO cdt-monitor\r\n`;
    resp = await talk(ehlo, [250]);

    // STARTTLS
    if (!tls && (secure === 'tls' || port === 587)) {
      resp = await talk('STARTTLS\r\n', [220]);
      await socket.startTls?.();
      resp = await talk(ehlo, [250]);
    }

    await talk('AUTH LOGIN\r\n', [334]);
    await talk(`${base64(username)}\r\n`, [334]);
    await talk(`${base64(password)}\r\n`, [235]);

    await talk(`MAIL FROM:<${username}>\r\n`, [250]);
    await talk(`RCPT TO:<${to}>\r\n`, [250, 251]);

    await talk('DATA\r\n', [354]);
    const headers = [
      `From: 阿里云CDT监控 <${username}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
    ].join('\r\n');
    const bodyB64 = btoa(unescape(encodeURIComponent(htmlBody)));
    await talk(`${headers}\r\n${bodyB64}\r\n.\r\n`, [250]);

    await talk('QUIT\r\n', [221]);
    return true;
  } catch (e: any) {
    return 'SMTP: ' + (e?.message || String(e));
  }
}

// ==================== Telegram ====================

export async function sendTelegram(text: string, cfg: NotifyConfig, override?: any): Promise<true | string> {
  const token = override?.token || cfg['notify_tg_token'] || '';
  const chatId = override?.chat_id || cfg['notify_tg_chat_id'] || '';
  const proxyType = override?.proxy_type || cfg['notify_tg_proxy_type'] || 'none';

  if (!token || !chatId) return 'Telegram Token 或 Chat ID 为空';

  let url = `https://api.telegram.org/bot${token}/sendMessage`;
  if (proxyType === 'custom' && (override?.proxy_url || cfg['notify_tg_proxy_url'])) {
    const base = (override?.proxy_url || cfg['notify_tg_proxy_url'] || '').replace(/\/+$/, '');
    url = `${base}/bot${token}/sendMessage`;
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: chatId, text }),
    });
    if (resp.status !== 200) return `Telegram HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
    return true;
  } catch (e: any) {
    return 'Telegram: ' + (e?.message || String(e));
  }
}

// ==================== Webhook ====================

export async function sendWebhook(
  text: string,
  title: string,
  summary: string,
  details: { label: string; value: string; highlight?: boolean }[],
  accountId: string,
  cfg: NotifyConfig,
  override?: any,
): Promise<true | string> {
  const url = override?.url || cfg['notify_wh_url'] || '';
  const method = (override?.method || cfg['notify_wh_method'] || 'GET').toUpperCase();
  const requestType = (override?.request_type || cfg['notify_wh_request_type'] || 'JSON').toUpperCase();
  const headersStr = override?.headers || cfg['notify_wh_headers'] || '';
  const bodyTemplate = override?.body || cfg['notify_wh_body'] || '';

  if (!url) return 'Webhook URL为空';

  let traffic = 'N/A';
  let maxTraffic = 'N/A';
  for (const d of details) {
    if (d.label === '当前流量') traffic = d.value.replace(' GB', '');
    if (d.label === '设定阈值') maxTraffic = d.value.replace('%', '');
  }

  const replacePairs: Record<string, string> = {
    '#TITLE#': title,
    '#MSG#': summary || text,
    '#ACCOUNT#': accountId,
    '#TRAFFIC#': traffic,
    '#MAX_TRAFFIC#': maxTraffic,
  };

  const customHeaders: string[] = [];
  if (headersStr) {
    try {
      const parsed = JSON.parse(headersStr);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) customHeaders.push(`${k}: ${v}`);
      }
    } catch {}
  }

  const urlReplaced = url.replace(/#(TITLE|MSG|ACCOUNT|TRAFFIC|MAX_TRAFFIC)#/g, (m: string) => encodeURIComponent(replacePairs[m] ?? ''));

  try {
    if (method === 'GET') {
      let finalUrl = urlReplaced;
      if (!bodyTemplate && !finalUrl.includes('?')) {
        const payload = new URLSearchParams({ title, text, time: nowText() });
        finalUrl += '?' + payload.toString();
      }
      const resp = await fetch(finalUrl);
      if (resp.status >= 400) return `Webhook HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
      return true;
    }

    // POST
    let finalBody = '';
    if (bodyTemplate) {
      let bodyReplaced = bodyTemplate;
      for (const [k, v] of Object.entries(replacePairs)) {
        const val = requestType === 'JSON' ? JSON.stringify(v).slice(1, -1) : encodeURIComponent(v);
        bodyReplaced = bodyReplaced.split(k).join(val);
      }
      finalBody = bodyReplaced;
      if (requestType === 'JSON') customHeaders.push('Content-Type: application/json');
      else if (requestType === 'FORM') {
        customHeaders.push('Content-Type: application/x-www-form-urlencoded');
        try {
          const decoded = JSON.parse(finalBody);
          if (decoded && typeof decoded === 'object') finalBody = new URLSearchParams(decoded).toString();
        } catch {}
      }
    } else {
      const payload = { title, text, time: nowText() };
      if (requestType === 'JSON') {
        finalBody = JSON.stringify(payload);
        customHeaders.push('Content-Type: application/json');
      } else {
        finalBody = new URLSearchParams(payload).toString();
        customHeaders.push('Content-Type: application/x-www-form-urlencoded');
      }
    }

    const resp = await fetch(urlReplaced, {
      method: 'POST',
      headers: Object.fromEntries(customHeaders.map((h) => h.split(': '))),
      body: finalBody,
    });
    if (resp.status >= 400) return `Webhook HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
    return true;
  } catch (e: any) {
    return 'Webhook: ' + (e?.message || String(e));
  }
}

// ==================== 组装 ====================

export function renderEmailTemplate(title: string, summary: string, details: { label: string; value: string; highlight?: boolean }[], type = 'info'): string {
  let color = '#007AFF';
  if (type === 'warning') color = '#FF3B30';
  if (type === 'success') color = '#34C759';

  const rows = details
    .map((item) => {
      const valColor = item.highlight ? color : '#1C1C1E';
      return `<tr style='border-bottom: 1px solid #F2F2F7;'>
        <td style='padding: 12px 0; color: #8E8E93; font-size: 14px; width: 40%;'>${item.label}</td>
        <td style='padding: 12px 0; color: ${valColor}; font-size: 14px; font-weight: 600; text-align: right;'>${item.value}</td>
      </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset='utf-8'></head>
<body style='margin: 0; padding: 0; background-color: #F2F2F7; font-family: sans-serif;'>
<table width='100%' border='0' cellspacing='0' cellpadding='0'><tr><td align='center' style='padding: 40px 20px;'>
<table width='100%' border='0' cellspacing='0' cellpadding='0' style='max-width: 500px; background-color: #FFFFFF; border-radius: 24px; overflow: hidden;'>
<tr><td style='height: 6px; background-color: ${color};'></td></tr>
<tr><td style='padding: 40px 30px;'>
<div style='color: ${color}; font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 8px;'>CDT MONITOR</div>
<h1 style='margin: 0 0 10px 0; font-size: 24px; color: #1C1C1E;'>${title}</h1>
<p style='margin: 0 0 30px 0; font-size: 15px; color: #8E8E93;'>${summary}</p>
<table width='100%' border='0' cellspacing='0' cellpadding='0' style='border-top: 1px solid #F2F2F7;'>${rows}</table>
</td></tr>
<tr><td style='background-color: #FAFAFC; padding: 20px; text-align: center; color: #AEAEB2; font-size: 12px;'>&copy; ${new Date().getFullYear()} CDT Monitor</td></tr>
</table></td></tr></table>
</body></html>`;
}

export interface NotificationResult {
  ok: boolean;
  message?: string;
}

export class Notifier {
  constructor(private cfg: NotifyConfig) {}

  setConfig(cfg: NotifyConfig) {
    this.cfg = cfg;
  }

  /** 分发所有已启用的通知渠道 */
  async dispatch(title: string, summary: string, details: any[], type: string, textMsg: string, accountId = ''): Promise<true | string> {
    const errors: string[] = [];
    let attempt = 0;
    let success = 0;

    // Email
    if ((this.cfg['notify_email_enabled'] ?? '1') === '1' && this.cfg['notify_email']) {
      attempt++;
      const html = renderEmailTemplate(title, summary, details, type);
      const res = await sendMail(this.cfg, this.cfg['notify_email'], `CDT通知 - ${title}`, html);
      if (res === true) success++;
      else errors.push('Email: ' + res);
    }

    // Telegram
    if ((this.cfg['notify_tg_enabled'] ?? '0') === '1' && this.cfg['notify_tg_token'] && this.cfg['notify_tg_chat_id']) {
      attempt++;
      const res = await sendTelegram(textMsg, this.cfg);
      if (res === true) success++;
      else errors.push('TG: ' + res);
    }

    // Webhook
    if ((this.cfg['notify_wh_enabled'] ?? '0') === '1' && this.cfg['notify_wh_url']) {
      attempt++;
      const res = await sendWebhook(textMsg, title, summary, details, accountId, this.cfg);
      if (res === true) success++;
      else errors.push('WH: ' + res);
    }

    if (attempt === 0) return true;
    if (success === 0 && errors.length) return errors.join(' | ');
    if (errors.length) return '部分完成: ' + errors.join(' | ');
    return true;
  }

  async notifySchedule(actionType: string, account: any, description = ''): Promise<true | string> {
    if ((this.cfg['enable_schedule_email'] ?? '0') !== '1') return true;
    const title = '定时任务: ' + actionType;
    const maskedKey = String(account.access_key_id).slice(0, 7) + '***';
    const traffic = account.traffic_used != null ? Math.round(account.traffic_used * 100) / 100 : 'N/A';
    const threshold = this.cfg['traffic_threshold'] ?? 95;

    const details = [
      { label: '账号 ID', value: maskedKey },
      { label: '执行动作', value: actionType, highlight: true },
      { label: '执行时间', value: nowText() },
      { label: '当前流量', value: `${traffic} GB` },
      { label: '设定阈值', value: `${threshold}%` },
      { label: '详情说明', value: description || '根据预设时间表自动执行。' },
    ];
    const textMsg = `【CDT Monitor】${title}\n账号 ID: ${maskedKey}\n执行动作: ${actionType}\n当前流量: ${traffic} GB\n设定阈值: ${threshold}%\n执行时间: ${nowText()}\n详情说明: ${description || '根据预设时间表自动执行。'}`;
    return this.dispatch(title, `您的实例已执行${actionType}操作`, details, 'info', textMsg, account.access_key_id);
  }

  async sendTrafficWarning(accessKeyId: string, traffic: number, percentage: number, statusText: string, threshold: number): Promise<true | string> {
    const title = '流量告警 - ' + statusText;
    const details = [
      { label: '账号 ID', value: String(accessKeyId).slice(0, 7) + '***' },
      { label: '当前流量', value: `${traffic} GB` },
      { label: '使用率', value: `${percentage}%`, highlight: true },
      { label: '设定阈值', value: `${threshold}%` },
      { label: '当前状态', value: statusText },
    ];
    const textMsg = `【CDT Monitor】${title}\n账号 ID: ${String(accessKeyId).slice(0, 7)}***\n当前流量: ${traffic} GB\n使用率: ${percentage}%\n设定阈值: ${threshold}%\n当前状态: ${statusText}`;
    return this.dispatch(title, '检测到流量异常或达到阈值', details, 'warning', textMsg, accessKeyId);
  }

  async sendTestEmail(to: string): Promise<true | string> {
    const details = [
      { label: '测试结果', value: '成功 (Success)' },
      { label: '发送时间', value: nowText() },
      { label: '服务器', value: 'Cloudflare Workers' },
    ];
    const html = renderEmailTemplate('测试邮件', 'SMTP 配置验证成功', details, 'success');
    return sendMail(this.cfg, to, 'CDT Monitor Test', html);
  }

  async sendTestTelegram(data: any): Promise<true | string> {
    const textMsg = `【CDT Monitor】测试推送\n这是一条来自 Telegram 的测试消息。\n发送时间: ${nowText()}`;
    return sendTelegram(textMsg, this.cfg, data);
  }

  async sendTestWebhook(data: any): Promise<true | string> {
    const textMsg = `【CDT Monitor】测试推送\n这是一条来自 Webhook 的测试消息。\n发送时间: ${nowText()}`;
    const summary = '这是一条来自 Webhook 的测试消息。';
    const threshold = this.cfg['traffic_threshold'] ?? 95;
    const details = [
      { label: '当前流量', value: '0 GB' },
      { label: '设定阈值', value: `${threshold}%` },
    ];
    return sendWebhook(textMsg, '测试推送', summary, details, 'test_account_id', this.cfg, data);
  }
}
