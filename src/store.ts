/**
 * D1 数据访问层 — 对应原版 Database.php + ConfigManager.php
 */
import type { Account } from './aliyun';

export interface Prepared {
  bind(...args: any[]): Prepared;
  first<T = any>(): Promise<T | null>;
  all<T = any>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: any }>;
}

export interface Db {
  prepare(sql: string): Prepared;
  batch(stmts: any[]): Promise<any[]>;
}

const now = () => Math.floor(Date.now() / 1000);

export class Store {
  constructor(public db: Db) {}

  // ============ settings ============
  async getSetting(key: string, def: string | null = null): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return row ? row.value : def;
  }

  async getAllSettings(): Promise<Record<string, string>> {
    const { results } = await this.db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
    const out: Record<string, string> = {};
    for (const r of results) out[r.key] = r.value;
    return out;
  }

  async saveSetting(key: string, value: string | number): Promise<void> {
    await this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind(key, String(value))
      .run();
  }

  async updateLastRunTime(t: number): Promise<void> {
    await this.saveSetting('last_monitor_run', t);
  }

  async getLastRunTime(): Promise<number> {
    const v = await this.getSetting('last_monitor_run', '0');
    return parseInt(v || '0', 10) || 0;
  }

  isInitialized(settings: Record<string, string>): boolean {
    return !!settings['admin_password'];
  }

  // ============ accounts ============
  async getAccounts(): Promise<Account[]> {
    const { results } = await this.db.prepare('SELECT * FROM accounts ORDER BY id ASC').all<any>();
    return results.map((r) => ({
      ...r,
      schedule_enabled: Number(r.schedule_enabled) || 0,
      max_traffic: Number(r.max_traffic) || 0,
      traffic_used: Number(r.traffic_used) || 0,
      updated_at: Number(r.updated_at) || 0,
      last_keep_alive_at: Number(r.last_keep_alive_at) || 0,
    }));
  }

  async getAccountById(id: number): Promise<Account | null> {
    const row = await this.db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<any>();
    if (!row) return null;
    return {
      ...row,
      schedule_enabled: Number(row.schedule_enabled) || 0,
      max_traffic: Number(row.max_traffic) || 0,
      traffic_used: Number(row.traffic_used) || 0,
      updated_at: Number(row.updated_at) || 0,
      last_keep_alive_at: Number(row.last_keep_alive_at) || 0,
    };
  }

  /** 配置全量保存：账号增量同步（对应 updateConfig 的账号部分） */
  async syncAccounts(newAccounts: any[]): Promise<void> {
    const existing = await this.getAccounts();
    const existingMap = new Map<string, number>();
    for (const row of existing) {
      const key = `${row.access_key_id}|${row.region_id}|${row.instance_id || ''}`;
      existingMap.set(key, row.id);
    }
    const keptIds: number[] = [];
    const stmts = [];

    for (const acc of newAccounts) {
      const compositeKey = `${acc.AccessKeyId}|${acc.regionId}|${acc.instanceId || ''}`;
      const params = [
        acc.AccessKeySecret,
        acc.regionId,
        acc.instanceId || '',
        acc.maxTraffic,
        acc.schedule?.enabled ? 1 : 0,
        acc.schedule?.startTime || '',
        acc.schedule?.stopTime || '',
        acc.remark || '',
        acc.siteType || 'china',
      ];
      const existingId = existingMap.get(compositeKey);
      if (existingId !== undefined) {
        keptIds.push(existingId);
        stmts.push(
          this.db
            .prepare(
              `UPDATE accounts SET access_key_secret=?, region_id=?, instance_id=?, max_traffic=?,
               schedule_enabled=?, start_time=?, stop_time=?, remark=?, site_type=? WHERE id=?`,
            )
            .bind(...params, existingId),
        );
      } else {
        stmts.push(
          this.db
            .prepare(
              `INSERT INTO accounts (access_key_id, access_key_secret, region_id, instance_id, max_traffic,
               schedule_enabled, start_time, stop_time, remark, site_type, traffic_used, instance_status, updated_at, last_keep_alive_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'Unknown', 0, 0)`,
            )
            .bind(acc.AccessKeyId, ...params),
        );
      }
    }

    const deleteIds = [...existingMap.values()].filter((id) => !keptIds.includes(id));
    if (deleteIds.length) {
      const ph = deleteIds.map(() => '?').join(',');
      stmts.push(this.db.prepare(`DELETE FROM accounts WHERE id IN (${ph})`).bind(...deleteIds));
    }

    if (stmts.length) await this.db.batch(stmts);
  }

  async updateAccountStatus(id: number, traffic: number, status: string, updatedAt: number): Promise<void> {
    await this.db
      .prepare('UPDATE accounts SET traffic_used=?, instance_status=?, updated_at=? WHERE id=?')
      .bind(traffic, status, updatedAt, id)
      .run();
  }

  async updateLastKeepAlive(id: number, t: number): Promise<void> {
    await this.db.prepare('UPDATE accounts SET last_keep_alive_at=? WHERE id=?').bind(t, id).run();
  }

  // ============ logs ============
  async addLog(type: string, message: string): Promise<void> {
    await this.db.prepare('INSERT INTO logs (type, message, created_at) VALUES (?, ?, ?)').bind(type, message, now()).run();
  }

  async getLogsByTypes(types: string[], limit = 20): Promise<any[]> {
    const ph = types.map(() => '?').join(',');
    const { results } = await this.db
      .prepare(`SELECT * FROM logs WHERE type IN (${ph}) ORDER BY id DESC LIMIT ?`)
      .bind(...types, limit)
      .all<any>();
    return results.map((r) => ({ ...r, time_str: fmtTime(Number(r.created_at)) }));
  }

  async clearLogsByTypes(types: string[]): Promise<void> {
    const ph = types.map(() => '?').join(',');
    await this.db.prepare(`DELETE FROM logs WHERE type IN (${ph})`).bind(...types).run();
  }

  /** 分级清理日志：普通日志 30 天，心跳日志 3 天 */
  async pruneLogs(): Promise<void> {
    await this.db
      .prepare("DELETE FROM logs WHERE type = 'heartbeat' AND created_at < ?")
      .bind(now() - 3 * 86400)
      .run();
    await this.db
      .prepare("DELETE FROM logs WHERE type != 'heartbeat' AND created_at < ?")
      .bind(now() - 30 * 86400)
      .run();
  }

  // ============ login attempts ============
  async recordLoginAttempt(ip: string): Promise<void> {
    await this.db.prepare('INSERT INTO login_attempts (ip, attempt_time) VALUES (?, ?)').bind(ip, now()).run();
  }

  async getRecentFailedAttempts(ip: string, windowSeconds = 900): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND attempt_time > ?')
      .bind(ip, now() - windowSeconds)
      .first<{ c: number }>();
    return row ? Number(row.c) : 0;
  }

  async clearLoginAttempts(ip: string): Promise<void> {
    await this.db.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  }

  // ============ stats ============
  async addHourlyStat(accountId: number, traffic: number): Promise<void> {
    const hourTs = Math.floor(now() / 3600) * 3600;
    await this.db
      .prepare('INSERT OR REPLACE INTO traffic_hourly (account_id, traffic, recorded_at) VALUES (?, ?, ?)')
      .bind(accountId, traffic, hourTs)
      .run();
  }

  async addDailyStat(accountId: number, traffic: number): Promise<void> {
    const d = new Date();
    const dayTs = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
    await this.db
      .prepare('INSERT OR REPLACE INTO traffic_daily (account_id, traffic, recorded_at) VALUES (?, ?, ?)')
      .bind(accountId, traffic, dayTs)
      .run();
  }

  async getHourlyStats(accountId: number): Promise<{ traffic: number; recorded_at: number }[]> {
    const { results } = await this.db
      .prepare('SELECT traffic, recorded_at FROM traffic_hourly WHERE account_id = ? ORDER BY recorded_at DESC LIMIT 25')
      .bind(accountId)
      .all<any>();
    return results.map((r) => ({ traffic: Number(r.traffic), recorded_at: Number(r.recorded_at) })).reverse();
  }

  async getDailyStats(accountId: number): Promise<{ traffic: number; recorded_at: number }[]> {
    const { results } = await this.db
      .prepare('SELECT traffic, recorded_at FROM traffic_daily WHERE account_id = ? ORDER BY recorded_at DESC LIMIT 31')
      .bind(accountId)
      .all<any>();
    return results.map((r) => ({ traffic: Number(r.traffic), recorded_at: Number(r.recorded_at) })).reverse();
  }

  async pruneStats(): Promise<void> {
    await this.db.prepare('DELETE FROM traffic_hourly WHERE recorded_at < ?').bind(now() - 48 * 3600).run();
    await this.db.prepare('DELETE FROM traffic_daily WHERE recorded_at < ?').bind(now() - 60 * 86400).run();
  }

  // ============ billing cache ============
  async setBillingCache(accountId: number, cacheType: string, billingCycle: string, data: any): Promise<void> {
    await this.db
      .prepare(
        'INSERT OR REPLACE INTO billing_cache (account_id, cache_type, billing_cycle, data, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(accountId, cacheType, billingCycle, JSON.stringify(data), now())
      .run();
  }

  async getBillingCache(accountId: number, cacheType: string, billingCycle: string, maxAge = 21600): Promise<any | null> {
    const row = await this.db
      .prepare('SELECT data, updated_at FROM billing_cache WHERE account_id=? AND cache_type=? AND billing_cycle=? LIMIT 1')
      .bind(accountId, cacheType, billingCycle)
      .first<{ data: string; updated_at: number }>();
    if (!row) return null;
    if (now() - Number(row.updated_at) > maxAge) return null;
    try {
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  }

  async pruneBillingCache(): Promise<void> {
    await this.db.prepare('DELETE FROM billing_cache WHERE updated_at < ?').bind(now() - 90 * 86400).run();
  }
}

export function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Asia/Shanghai 时区当前时间字符串 HH:mm */
export function shanghaiTimeStr(): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === 'hour')?.value || '00';
  const m = parts.find((p) => p.type === 'minute')?.value || '00';
  return `${h}:${m}`;
}

/** Asia/Shanghai 时区当前 HH 是否等于指定值（用于凌晨维护窗口） */
export function shanghaiHourMinute(): { h: string; m: string } {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return {
    h: parts.find((p) => p.type === 'hour')?.value || '00',
    m: parts.find((p) => p.type === 'minute')?.value || '00',
  };
}
