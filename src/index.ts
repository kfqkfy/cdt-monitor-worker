/**
 * CDT-Monitor Worker 主入口
 * 路由对应原版 index.php 的 ?action=xxx 接口
 */
import { Store, fmtTime } from './store';
import { Monitor } from './monitor';
import { Notifier } from './notify';

interface Env {
  DB: any;
  ASSETS?: any;
  SESSION_SECRET?: string;
}

const COOKIE_NAME = 'cdt_admin';
const SESSION_TTL = 7 * 24 * 3600; // 7 天

function json(data: any, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || '0.0.0.0';
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

class Auth {
  constructor(private store: Store, private secret: string) {}

  async createSession(): Promise<string> {
    const payload = `${Date.now()}.${crypto.randomUUID()}`;
    const sig = await hmacSign(this.secret, payload);
    return `${payload}.${sig}`;
  }

  async verify(token: string | null): Promise<boolean> {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = `${parts[0]}.${parts[1]}`;
    const sig = await hmacSign(this.secret, payload);
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(parts[2], 'hex');
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    if (diff !== 0) return false;
    const ts = parseInt(parts[0], 10);
    return Date.now() - ts < SESSION_TTL * 1000;
  }

  sessionCookie(token: string): string {
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}`;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const store = new Store(env.DB);
    const monitor = new Monitor(store);
    const url = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    // 静态资源（无 action 参数的请求全部尝试 assets，未命中再 fallback）
    if (!action) {
      const assetRes = await serveAsset(env, request);
      if (assetRes) return assetRes;
    }

    // 仅保留 ?action= 路由（兼容原版前端模板）
    const auth = new Auth(store, env.SESSION_SECRET || 'cdt-monitor-default-secret');

    try {
      // ---- 公开接口 ----
      if (action === 'check_init') {
        const settings = await store.getAllSettings();
        const initialized = store.isInitialized(settings);
        return json({ initialized });
      }

      if (action === 'setup') {
        const settings = await store.getAllSettings();
        if (store.isInitialized(settings)) {
          return json({ success: false, message: 'System already initialized' }, 403);
        }
        const data: any = await request.json();
        try {
          await saveConfig(store, data);
          const token = await auth.createSession();
          return json({ success: true }, 200, { 'Set-Cookie': auth.sessionCookie(token) });
        } catch (e: any) {
          return json({ success: false, message: e?.message || 'Setup failed' });
        }
      }

      if (action === 'login') {
        const ip = clientIp(request);
        const attempts = await store.getRecentFailedAttempts(ip, 900);
        if (attempts >= 5) {
          await store.addLog('warning', `登录被锁定: IP ${ip} 尝试次数过多`);
          return json({ success: false, message: '错误次数过多，请 15 分钟后再试。' });
        }
        const { password } = (await request.json()) as any;
        const settings = await store.getAllSettings();
        const adminPass = settings['admin_password'] || '';
        if (adminPass && password === adminPass) {
          await store.clearLoginAttempts(ip);
          await store.addLog('info', `管理员登录成功 [IP: ${ip}]`);
          const token = await auth.createSession();
          return json({ success: true }, 200, { 'Set-Cookie': auth.sessionCookie(token) });
        }
        await store.recordLoginAttempt(ip);
        await store.addLog('warning', `管理员登录失败 [IP: ${ip}]`);
        return json({ success: false, message: '密码错误' });
      }

      if (action === 'check_login') {
        const cookie = getCookie(request, COOKIE_NAME);
        return json({ logged_in: await auth.verify(cookie) });
      }

      if (action === 'get_status') {
        return json(await monitor.getStatusForFrontend());
      }

      // ---- 需鉴权接口 ----
      const cookie = getCookie(request, COOKIE_NAME);
      if (!(await auth.verify(cookie))) {
        return json({ error: 'Unauthorized' }, 403);
      }

      switch (action) {
        case 'control_instance': {
          const { id, action: act } = (await request.json()) as any;
          if (!id || !act) return json({ success: false, message: '参数缺失' });
          const r = await monitor.controlInstance(id, act);
          return json(r);
        }
        case 'get_config': {
          return json(await getConfigForFrontend(store));
        }
        case 'save_config': {
          const data = await request.json();
          try {
            await saveConfig(store, data);
            return json({ success: true });
          } catch {
            return json({ success: false, message: '保存失败' });
          }
        }
        case 'send_test_email': {
          const { email } = (await request.json()) as any;
          const settings = await store.getAllSettings();
          const notifier = new Notifier(settings);
          const result = await notifier.sendTestEmail(email || '');
          return json({ success: result === true, message: result === true ? '' : result });
        }
        case 'send_test_telegram': {
          const { telegram } = (await request.json()) as any;
          const settings = await store.getAllSettings();
          const notifier = new Notifier(settings);
          const result = await notifier.sendTestTelegram(telegram || {});
          return json({ success: result === true, message: result === true ? '' : result });
        }
        case 'send_test_webhook': {
          const { webhook } = (await request.json()) as any;
          const settings = await store.getAllSettings();
          const notifier = new Notifier(settings);
          const result = await notifier.sendTestWebhook(webhook || {});
          return json({ success: result === true, message: result === true ? '' : result });
        }
        case 'refresh_account': {
          const { id } = (await request.json()) as any;
          const result = await monitor.refreshAccount(Number(id));
          if (result === false) return json({ success: false, message: 'Refresh failed' });
          if (typeof result === 'object') return json(result);
          return json({ success: true });
        }
        case 'get_logs': {
          const tab = url.searchParams.get('tab') || 'action';
          const types = tab === 'heartbeat' ? ['heartbeat'] : ['info', 'warning'];
          const logs = await store.getLogsByTypes(types, 20);
          return json({ data: logs });
        }
        case 'clear_logs': {
          const { tab } = (await request.json()) as any;
          const types = tab === 'heartbeat' ? ['heartbeat'] : ['info', 'warning', 'error'];
          await store.clearLogsByTypes(types);
          return json({ success: true });
        }
        case 'get_history': {
          const id = Number(url.searchParams.get('id') || 0);
          const data = await monitor.getAccountHistory(id);
          return json({ data });
        }
        case 'logout': {
          return json({ success: true }, 200, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0` });
        }
        default:
          return json({ error: 'Not Found', message: `Unknown action: ${action}` }, 404);
      }
    } catch (e: any) {
      return json({ error: 'Internal Serverless Error', message: e?.message || String(e) }, 500);
    }
  },

  /** 每分钟触发 — 对应原版 cron monitor.php */
  async scheduled(_event: any, env: Env, ctx: any): Promise<void> {
    ctx.waitUntil(runMonitor(env));
  },
};

async function runMonitor(env: Env): Promise<void> {
  const store = new Store(env.DB);
  const monitor = new Monitor(store);
  try {
    const output = await monitor.monitor();
    console.log('[monitor]', output.replace(/\n/g, ' | ').slice(0, 2000));
  } catch (e: any) {
    console.error('[monitor] error:', e?.message || e);
    try {
      await store.addLog('error', `监控任务异常: ${e?.message || e}`);
    } catch {}
  }
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** 读取静态资源（通过 assets 绑定）。成功返回 Response，未命中返回 null */
async function serveAsset(env: Env, request: Request): Promise<Response | null> {
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(request);
    if (res.ok) return res;
    if (res.status !== 404) {
      return res;
    }
  }
  return null;
}

async function getConfigForFrontend(store: Store): Promise<any> {
  const settings = await store.getAllSettings();
  const accounts = await store.getAccounts();

  const config: any = {
    admin_password: settings['admin_password'] || '',
    traffic_threshold: parseInt(settings['traffic_threshold'] || '95', 10) || 95,
    enable_schedule_email: settings['enable_schedule_email'] === '1',
    shutdown_mode: settings['shutdown_mode'] || 'KeepCharging',
    threshold_action: settings['threshold_action'] || 'stop_and_notify',
    keep_alive: settings['keep_alive'] === '1',
    api_interval: parseInt(settings['api_interval'] || '600', 10) || 600,
    enable_billing: settings['enable_billing'] === '1',
    Notification: {
      email_enabled: settings['notify_email_enabled'] !== '0',
      email: settings['notify_email'] || '',
      host: settings['notify_host'] || '',
      port: parseInt(settings['notify_port'] || '465', 10),
      username: settings['notify_username'] || '',
      password: settings['notify_password'] || '',
      secure: settings['notify_secure'] || 'ssl',
      telegram: {
        enabled: settings['notify_tg_enabled'] === '1',
        token: settings['notify_tg_token'] || '',
        chat_id: settings['notify_tg_chat_id'] || '',
        proxy_type: settings['notify_tg_proxy_type'] || 'none',
        proxy_url: settings['notify_tg_proxy_url'] || '',
        proxy_ip: settings['notify_tg_proxy_ip'] || '',
        proxy_port: settings['notify_tg_proxy_port'] || '',
        proxy_user: settings['notify_tg_proxy_user'] || '',
        proxy_pass: settings['notify_tg_proxy_pass'] || '',
      },
      webhook: {
        enabled: settings['notify_wh_enabled'] === '1',
        url: settings['notify_wh_url'] || '',
        method: settings['notify_wh_method'] || 'GET',
        request_type: settings['notify_wh_request_type'] || 'JSON',
        headers: settings['notify_wh_headers'] || '',
        body: settings['notify_wh_body'] || '',
      },
    },
    Accounts: [],
  };

  for (const row of accounts) {
    config.Accounts.push({
      AccessKeyId: row.access_key_id,
      AccessKeySecret: row.access_key_secret,
      regionId: row.region_id,
      instanceId: row.instance_id,
      maxTraffic: row.max_traffic,
      schedule: {
        enabled: row.schedule_enabled == 1,
        startTime: row.start_time,
        stopTime: row.stop_time,
      },
      remark: row.remark || '',
      siteType: row.site_type || 'china',
    });
  }
  return config;
}

async function saveConfig(store: Store, data: any): Promise<void> {
  // 全局设置
  await store.saveSetting('admin_password', data.admin_password || '');
  await store.saveSetting('traffic_threshold', data.traffic_threshold ?? 95);
  await store.saveSetting('enable_schedule_email', data.enable_schedule_email ? '1' : '0');
  await store.saveSetting('shutdown_mode', data.shutdown_mode || 'KeepCharging');
  await store.saveSetting('threshold_action', data.threshold_action || 'stop_and_notify');
  await store.saveSetting('keep_alive', data.keep_alive ? '1' : '0');
  await store.saveSetting('api_interval', data.api_interval ?? 600);
  await store.saveSetting('enable_billing', data.enable_billing ? '1' : '0');

  const N = data.Notification || {};
  await store.saveSetting('notify_email_enabled', N.email_enabled ? '1' : '0');
  await store.saveSetting('notify_email', N.email || '');
  await store.saveSetting('notify_host', N.host || '');
  await store.saveSetting('notify_port', N.port ?? 465);
  await store.saveSetting('notify_username', N.username || '');
  await store.saveSetting('notify_password', N.password || '');
  await store.saveSetting('notify_secure', N.secure || 'ssl');

  const tg = N.telegram || {};
  await store.saveSetting('notify_tg_enabled', tg.enabled ? '1' : '0');
  await store.saveSetting('notify_tg_token', tg.token || '');
  await store.saveSetting('notify_tg_chat_id', tg.chat_id || '');
  await store.saveSetting('notify_tg_proxy_type', tg.proxy_type || 'none');
  await store.saveSetting('notify_tg_proxy_url', tg.proxy_url || '');
  await store.saveSetting('notify_tg_proxy_ip', tg.proxy_ip || '');
  await store.saveSetting('notify_tg_proxy_port', tg.proxy_port || '');
  await store.saveSetting('notify_tg_proxy_user', tg.proxy_user || '');
  await store.saveSetting('notify_tg_proxy_pass', tg.proxy_pass || '');

  const wh = N.webhook || {};
  await store.saveSetting('notify_wh_enabled', wh.enabled ? '1' : '0');
  await store.saveSetting('notify_wh_url', wh.url || '');
  await store.saveSetting('notify_wh_method', wh.method || 'GET');
  await store.saveSetting('notify_wh_request_type', wh.request_type || 'JSON');
  await store.saveSetting('notify_wh_headers', wh.headers || '');
  await store.saveSetting('notify_wh_body', wh.body || '');

  // 账号同步
  await store.syncAccounts(data.Accounts || []);
}
