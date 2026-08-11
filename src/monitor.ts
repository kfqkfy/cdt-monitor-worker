/**
 * 核心监控逻辑 — 对应原版 AliyunTrafficCheck.php
 */
import type { Account } from './aliyun';
import { AliyunClient } from './aliyun';
import { Store, shanghaiTimeStr, shanghaiHourMinute, shanghaiMonth, shanghaiHM, shanghaiDate, fmtTime } from './store';
import { Notifier } from './notify';

const REGION_NAMES: Record<string, string> = {
  'cn-hongkong': '中国香港',
  'ap-southeast-1': '新加坡',
  'us-west-1': '美国(硅谷)',
  'us-east-1': '美国(弗吉尼亚)',
  'cn-hangzhou': '华东1(杭州)',
  'cn-shanghai': '华东2(上海)',
  'cn-qingdao': '华北1(青岛)',
  'cn-beijing': '华北2(北京)',
  'cn-zhangjiakou': '华北3(张家口)',
  'cn-huhehaote': '华北5(呼和浩特)',
  'cn-wulanchabu': '华北6(乌兰察布)',
  'cn-shenzhen': '华南1(深圳)',
  'cn-heyuan': '华南2(河源)',
  'cn-guangzhou': '华南3(广州)',
  'cn-chengdu': '西南1(成都)',
  'ap-northeast-1': '日本(东京)',
};

const TRANSIENT_STATES = ['Starting', 'Stopping', 'Pending', 'Unknown'];

function isTimeInRange(current: string, start: string, end: string): boolean {
  if (!start || !end) return false;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export class Monitor {
  private client = new AliyunClient();

  constructor(private store: Store) {}

  private async getNotifier(): Promise<Notifier> {
    return new Notifier(await this.store.getAllSettings());
  }

  private async logNotificationResult(result: true | string | undefined, key: string) {
    if (result === true) {
      await this.store.addLog('info', `通知推送成功 [${key}]`);
    } else if (typeof result === 'string' && result !== '') {
      await this.store.addLog('warning', `通知推送异常/失败 [${key}]: ${result}`);
    }
  }

  private async safeGetTraffic(account: Account): Promise<number> {
    try {
      return await this.client.getTraffic(account);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (e?.Code) await this.store.addLog('error', `流量查询配置错误: ${e.Code}`);
      else if (/超时|timeout|abort/i.test(msg)) await this.store.addLog('error', '流量查询失败: 阿里云接口超时');
      else await this.store.addLog('error', '流量查询失败: 系统未知错误');
      return -1;
    }
  }

  private async safeGetInstanceStatus(account: Account): Promise<string> {
    try {
      return await this.client.getInstanceStatus(account);
    } catch (e: any) {
      if (e?.Code) await this.store.addLog('error', `实例状态查询配置错误: 鉴权失败`);
      return 'Unknown';
    }
  }

  private async safeControlInstance(account: Account, action: 'start' | 'stop', shutdownMode = 'KeepCharging'): Promise<boolean> {
    try {
      return await this.client.controlInstance(account, action, shutdownMode);
    } catch (e: any) {
      await this.store.addLog('error', `实例操作失败 [${action}]: ${e?.Code ? '权限不足或配置错误' : e?.message || '无法连接API'}`);
      return false;
    }
  }

  /** 每分钟 cron 入口 — 对应原版 monitor() */
  async monitor(): Promise<string> {
    const settings = await this.store.getAllSettings();
    const notifier = new Notifier(settings);

    // 清理
    await this.store.pruneLogs();
    await this.store.pruneStats();
    await this.store.pruneBillingCache();

    // 每天 04:00 清理旧登录尝试（对应原版 VACUUM 时机的近似）
    const { h, m } = shanghaiHourMinute();
    if (h === '04' && m === '00') {
      await this.store.db.prepare('DELETE FROM login_attempts WHERE attempt_time < ?').bind(Math.floor(Date.now() / 1000) - 7 * 86400).run();
    }

    const currentUserTime = shanghaiTimeStr();
    const currentTime = Math.floor(Date.now() / 1000);
    const threshold = parseInt(settings['traffic_threshold'] || '95', 10) || 95;
    const shutdownMode = settings['shutdown_mode'] || 'KeepCharging';
    const thresholdAction = settings['threshold_action'] || 'stop_and_notify';
    const keepAlive = settings['keep_alive'] === '1';
    const userInterval = parseInt(settings['api_interval'] || '600', 10) || 600;

    const accounts = await this.store.getAccounts();
    const logs: string[] = [];

    for (const account of accounts) {
      const logPrefix = `[${account.access_key_id}]`;
      const actions: string[] = [];
      let forceRefresh = false;
      let statusTransformed = false;
      let traffic = account.traffic_used;
      let status = account.instance_status || 'Unknown';
      let apiStatusLog = '';
      let lastUpdate = account.updated_at || 0;

      // ---- 1. 定时任务（按 Asia/Shanghai 时间）----
      if (account.schedule_enabled == 1) {
        if (account.start_time && currentUserTime === account.start_time) {
          if (await this.safeControlInstance(account, 'start')) {
            actions.push('定时启动');
            await this.store.addLog('info', `执行定时启动 [${account.access_key_id}]`);
            const mailRes = await notifier.notifySchedule('定时启动', account, '计划任务已触发，实例正在启动。');
            await this.logNotificationResult(mailRes, account.access_key_id);
            forceRefresh = true;
            statusTransformed = true;
          }
        }
        if (account.stop_time && currentUserTime === account.stop_time) {
          if (await this.safeControlInstance(account, 'stop', shutdownMode)) {
            actions.push(`定时停止(${shutdownMode})`);
            await this.store.addLog('info', `执行定时停止 [${account.access_key_id}]`);
            const mailRes = await notifier.notifySchedule('定时停止', account, '计划任务已触发，实例已停止。');
            await this.logNotificationResult(mailRes, account.access_key_id);
            forceRefresh = true;
            statusTransformed = true;
          }
        }
      }

      // ---- 2. 自适应心跳 ----
      const isTransientState = TRANSIENT_STATES.includes(status);
      const currentInterval = isTransientState || statusTransformed ? 60 : userInterval;
      let shouldCheckApi = forceRefresh || currentTime - lastUpdate > currentInterval;
      const mm = shanghaiHourMinute().m;
      if (mm === '00') shouldCheckApi = true;

      let newUpdateTime = currentTime;

      if (shouldCheckApi) {
        const newTraffic = await this.safeGetTraffic(account);
        let newStatus = await this.safeGetInstanceStatus(account);
        if (newStatus === 'Unknown') {
          await new Promise((r) => setTimeout(r, 500));
          newStatus = await this.safeGetInstanceStatus(account);
        }

        if (newTraffic < 0) {
          apiStatusLog = '流量API异常';
          newUpdateTime = lastUpdate;
        } else {
          traffic = newTraffic;
          apiStatusLog = '已更新';
          await this.store.addHourlyStat(account.id, traffic);
          await this.store.addDailyStat(account.id, traffic);
        }

        if (newStatus === 'Unknown') {
          newUpdateTime = lastUpdate;
          apiStatusLog += '(状态Unknown)';
        } else {
          status = newStatus;
          apiStatusLog += TRANSIENT_STATES.includes(newStatus) ? ' [过渡态]' : ' [稳定态]';
        }

        await this.store.updateAccountStatus(account.id, traffic, status, newUpdateTime);
      } else {
        const timeLeft = currentInterval - (currentTime - lastUpdate);
        apiStatusLog = `缓存(${timeLeft}s)`;
      }

      // ---- 3. 流量熔断 ----
      const maxTraffic = account.max_traffic;
      const usagePercent = maxTraffic > 0 ? Math.round((traffic / maxTraffic) * 10000) / 100 : 0;
      let trafficDesc = `流量:${usagePercent}%`;
      const isOverThreshold = usagePercent >= threshold;

      if (isOverThreshold) {
        trafficDesc += '[警告]';
        if (shouldCheckApi) {
          if (thresholdAction === 'stop_and_notify') {
            if (status !== 'Stopped') {
              if (await this.safeControlInstance(account, 'stop', shutdownMode)) {
                actions.push('超限关机');
                await this.store.addLog('warning', `流量超限自动关机 [${account.access_key_id}] 使用率:${usagePercent}%`);
                await this.store.updateAccountStatus(account.id, traffic, 'Stopping', currentTime);
                status = 'Stopping';
              }
            }
          } else {
            actions.push('超限告警');
            await this.store.addLog('warning', `流量超限触发告警 [${account.access_key_id}] 使用率:${usagePercent}%`);
          }
          const mailRes = await notifier.sendTrafficWarning(account.access_key_id, traffic, usagePercent, actions.join(',') || '超限', threshold);
          await this.logNotificationResult(mailRes, account.access_key_id);
        }
      }

      // ---- 4. 保活逻辑 ----
      if (keepAlive && !isOverThreshold && !statusTransformed) {
        if (account.schedule_enabled == 0 || isTimeInRange(currentUserTime, account.start_time, account.stop_time)) {
          if (status === 'Stopped') {
            if (await this.safeControlInstance(account, 'start')) {
              actions.push('保活启动');
              await this.store.addLog('info', `执行保活启动 [${account.access_key_id}]`);
              const mailRes = await notifier.notifySchedule('保活启动', account, '检测到实例在工作时段非预期关机，已尝试自动启动。');
              await this.logNotificationResult(mailRes, account.access_key_id);
              await this.store.updateAccountStatus(account.id, traffic, 'Starting', currentTime);
              status = 'Starting';
            } else {
              apiStatusLog += ' [保活启动失败,下次重试]';
            }
          }
        }
      }

      if (statusTransformed) {
        const tempStatus = actions.includes('定时启动') ? 'Starting' : 'Stopping';
        await this.store.updateAccountStatus(account.id, traffic, tempStatus, currentTime);
        apiStatusLog += ' -> 强制过渡态';
      }

      const actionLog = actions.length ? actions.join(', ') : '无动作';
      const logLine = `${logPrefix} ${actionLog} | ${trafficDesc} | ${status} | ${apiStatusLog}`;
      await this.store.addLog('heartbeat', logLine);
      logs.push(logLine);
    }

    await this.store.updateLastRunTime(currentTime);
    return logs.join('\n');
  }

  /** 前端状态卡片 — 对应 getStatusForFrontend */
  async getStatusForFrontend(): Promise<any> {
    const settings = await this.store.getAllSettings();
    const threshold = parseInt(settings['traffic_threshold'] || '95', 10) || 95;
    const userInterval = parseInt(settings['api_interval'] || '600', 10) || 600;
    const billingEnabled = settings['enable_billing'] === '1';
    const currentTime = Math.floor(Date.now() / 1000);
    const accounts = await this.store.getAccounts();
    const billingCycle = shanghaiMonth();

    const data = [];
    for (const account of accounts) {
      const lastUpdate = account.updated_at || 0;
      let cachedStatus = account.instance_status || 'Unknown';
      const isTransient = TRANSIENT_STATES.includes(cachedStatus);
      const checkInterval = isTransient ? 60 : userInterval;
      let traffic = account.traffic_used;
      let status = cachedStatus;
      let newUpdateTime = currentTime;

      if (currentTime - lastUpdate > checkInterval) {
        const newTraffic = await this.safeGetTraffic(account);
        let newStatus = await this.safeGetInstanceStatus(account);
        if (newStatus === 'Unknown') {
          await new Promise((r) => setTimeout(r, 500));
          newStatus = await this.safeGetInstanceStatus(account);
        }
        if (newTraffic >= 0) {
          traffic = newTraffic;
          await this.store.addHourlyStat(account.id, traffic);
          await this.store.addDailyStat(account.id, traffic);
        } else {
          newUpdateTime = lastUpdate;
        }
        if (newStatus === 'Unknown') newUpdateTime = lastUpdate;
        else status = newStatus;
        await this.store.updateAccountStatus(account.id, traffic, status, newUpdateTime);
      }

      const usagePercent = account.max_traffic > 0 ? Math.round((traffic / account.max_traffic) * 10000) / 100 : 0;
      const item: any = {
        id: account.id,
        account: String(account.access_key_id).slice(0, 7) + '***',
        flow_total: account.max_traffic,
        flow_used: Math.round(traffic * 100) / 100,
        percentageOfUse: usagePercent,
        region: account.region_id,
        regionName: REGION_NAMES[account.region_id] || account.region_id,
        rate95: usagePercent >= threshold,
        threshold,
        instanceStatus: status,
        lastUpdated: fmtTime(lastUpdate > 0 ? lastUpdate : currentTime),
        remark: account.remark || '',
      };

      if (billingEnabled) {
        item.cost = await this.safeGetBillingInfo(account, billingCycle);
      }
      data.push(item);
    }

    return { data, system_last_run: await this.store.getLastRunTime() };
  }

  /** 手动刷新单个账号 — 对应 refreshAccount */
  async refreshAccount(id: number): Promise<boolean | { success: boolean; billing_error: string }> {
    const target = await this.store.getAccountById(id);
    if (!target) return false;

    const currentTime = Math.floor(Date.now() / 1000);
    const traffic = await this.safeGetTraffic(target);
    const status = await this.safeGetInstanceStatus(target);
    let finalTraffic = traffic;
    if (traffic < 0) {
      finalTraffic = target.traffic_used;
    } else {
      await this.store.addHourlyStat(id, traffic);
      await this.store.addDailyStat(id, traffic);
    }
    await this.store.updateAccountStatus(id, finalTraffic, status, currentTime);

    const settings = await this.store.getAllSettings();
    const billingEnabled = settings['enable_billing'] === '1';
    if (!billingEnabled) return true;

    const billingCycle = shanghaiMonth();
    let billingError: string | null = null;

    const balanceCache = await this.store.getBillingCache(id, 'balance', '', 21600);
    if (!balanceCache) {
      try {
        const balance = await this.client.getAccountBalance(target);
        await this.store.setBillingCache(id, 'balance', '', balance);
      } catch (e: any) {
        billingError = '余额查询失败: ' + e?.message;
      }
    }

    if (target.instance_id) {
      const billCache = await this.store.getBillingCache(id, 'instance_bill', billingCycle, 21600);
      if (!billCache) {
        try {
          const bill = await this.client.getInstanceBill(target, billingCycle);
          await this.store.setBillingCache(id, 'instance_bill', billingCycle, bill);
        } catch (e: any) {
          billingError = (billingError ? billingError + '; ' : '') + '账单查询失败: ' + e?.message;
        }
      }
    }

    if (billingError) {
      await this.store.addLog('warning', `账单刷新异常 [${target.access_key_id}]: ${billingError}`);
      return { success: true, billing_error: billingError };
    }
    return true;
  }

  /** 手动控制实例 — 对应 controlInstance */
  async controlInstance(id: number, action: string): Promise<{ success: boolean; message: string }> {
    const account = await this.store.getAccountById(id);
    if (!account) return { success: false, message: '账户配置未找到' };

    const currentStatus = account.instance_status || 'Unknown';
    if (['Pending', 'Starting', 'Stopping'].includes(currentStatus)) {
      return { success: false, message: `实例状态更新中 (${currentStatus})，请稍后刷新页面查看最新状态，不要重复操作。` };
    }

    const settings = await this.store.getAllSettings();
    const keepAlive = settings['keep_alive'] === '1';
    if (keepAlive && action.toLowerCase() === 'stop') {
      await this.store.addLog('warning', `拒绝手动关机请求 [${account.access_key_id}]: 实例保活功能已开启`);
      return { success: false, message: '操作被拒绝：当前开启了"实例保活"模式，不允许手动关机。' };
    }

    const shutdownMode = settings['shutdown_mode'] || 'KeepCharging';
    const result = await this.safeControlInstance(account, action.toLowerCase() as 'start' | 'stop', shutdownMode);
    if (result === true) {
      await this.store.addLog('info', `手动控制实例 [${account.access_key_id}] 执行: ${action}`);
      return { success: true, message: '指令发送成功' };
    }
    return { success: false, message: `操作执行失败: ${result}` };
  }

  /** 账户历史图表数据 — 对应 getAccountHistory */
  async getAccountHistory(id: number): Promise<any> {
    const account = await this.store.getAccountById(id);
    if (!account) return { error: 'Account not found' };

    const rawHourly = await this.store.getHourlyStats(id);
    const chartHourly = rawHourly.map((r) => ({
      time: shanghaiHM(r.recorded_at),
      full_time: fmtTime(r.recorded_at),
      value: Math.round(r.traffic * 1000) / 1000,
    }));

    const rawDaily = await this.store.getDailyStats(id);
    const chartDaily = rawDaily.map((r) => ({
      date: shanghaiDate(r.recorded_at),
      value: Math.round(r.traffic * 1000) / 1000,
    }));

    return { history_24h: chartHourly, history_30d: chartDaily };
  }

  /** 费用信息（带缓存）— 对应 safeGetBillingInfo */
  private async safeGetBillingInfo(account: Account, billingCycle: string): Promise<any> {
    const costInfo: any = {
      enabled: true,
      monthly_cost: null,
      balance: null,
      currency: 'CNY',
      last_updated: null,
      error: null,
    };

    const balanceCache = await this.store.getBillingCache(account.id, 'balance', '', 21600);
    if (balanceCache) {
      costInfo.balance = balanceCache.AvailableAmount;
      costInfo.currency = balanceCache.Currency || 'CNY';
    } else {
      try {
        const balance = await this.client.getAccountBalance(account);
        costInfo.balance = balance.AvailableAmount;
        costInfo.currency = balance.Currency || 'CNY';
        await this.store.setBillingCache(account.id, 'balance', '', balance);
      } catch {
        costInfo.error = '余额查询失败';
      }
    }

    if (account.instance_id) {
      const billCache = await this.store.getBillingCache(account.id, 'instance_bill', billingCycle, 21600);
      if (billCache) {
        costInfo.monthly_cost = billCache.TotalCost;
      } else {
        try {
          const bill = await this.client.getInstanceBill(account, billingCycle);
          costInfo.monthly_cost = bill.TotalCost;
          await this.store.setBillingCache(account.id, 'instance_bill', billingCycle, bill);
        } catch {
          costInfo.error = costInfo.error ? 'BSS权限不足' : '账单查询失败';
        }
      }
    }

    costInfo.last_updated = fmtTime(Math.floor(Date.now() / 1000));
    return costInfo;
  }
}
