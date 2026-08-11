/**
 * 阿里云 RPC 风格 OpenAPI 客户端 (Workers 版)
 * 对应原版 AliyunService.php，使用标准 RPC 签名 V1 (HMAC-SHA1)
 */

export interface Account {
  id: number;
  access_key_id: string;
  access_key_secret: string;
  region_id: string;
  instance_id: string;
  max_traffic: number;
  schedule_enabled: number;
  start_time: string;
  stop_time: string;
  traffic_used: number;
  instance_status: string;
  updated_at: number;
  last_keep_alive_at: number;
  remark: string;
  site_type: string;
}

export interface RpcRequest {
  product: string;
  version: string;
  action: string;
  host: string;
  regionId: string;
  query?: Record<string, string | number>;
  timeout?: number;
}

/** URL 编码（阿里云要求：空格 %20，非 RFC3986 的 +） */
function percentEncode(s: string): string {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

async function hmacSha1(key: string, data: string): Promise<string> {
  const keyBuf = new TextEncoder().encode(key);
  const dataBuf = new TextEncoder().encode(data);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, dataBuf);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** 指数退避重试（对应原版 executeWithRetry） */
async function executeWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const code = String(e?.Code || e?.code || '');
      const isThrottling = /throttling/i.test(code);
      // 4xx 且非流控：直接抛出（如 AccessKey 错误）
      if (!isThrottling && (e?.statusCode >= 400 && e?.statusCode < 500)) {
        throw e;
      }
      if (attempt < maxRetries - 1) {
        const base = Math.pow(2, attempt + 1) * 1000;
        const wait = base + Math.random() * 500;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

export class AliyunClient {
  async rpc(req: RpcRequest, accessKeyId: string, accessKeySecret: string): Promise<any> {
    return executeWithRetry(async () => {
      const params: Record<string, string> = {
        AccessKeyId: accessKeyId,
        Action: req.action,
        Format: 'JSON',
        RegionId: req.regionId,
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: crypto.randomUUID(),
        SignatureVersion: '1.0',
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        Version: req.version,
        ...Object.fromEntries(
          Object.entries(req.query || {}).map(([k, v]) => [k, String(v)]),
        ),
      };

      const sortedKeys = Object.keys(params).sort();
      const canonicalQuery = sortedKeys
        .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
        .join('&');

      const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonicalQuery)}`;
      const signature = await hmacSha1(`${accessKeySecret}&`, stringToSign);
      params.Signature = signature;

      const body = new URLSearchParams(params).toString();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeout || 10000);

      let resp: Response;
      try {
        resp = await fetch(`https://${req.host}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const text = await resp.text();
      let json: any = {};
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Aliyun API 非 JSON 响应 (${resp.status}): ${text.slice(0, 200)}`);
      }

      // BSS 等 API 成功响应也带 Code 字段（如 Code:"Success", Message:"Successful!"），
      // 只有 Code 存在且不是 Success/200 才视为错误
      const code = json.Code;
      const okCode =
        code === undefined ||
        code === null ||
        String(code).toUpperCase() === 'SUCCESS' ||
        String(code) === '200';
      if (!resp.ok || !okCode) {
        const err: any = new Error(json.Message || `HTTP ${resp.status}`);
        err.Code = code;
        err.statusCode = resp.status;
        throw err;
      }
      return json;
    });
  }

  private isOverseas(regionId: string): boolean {
    return !(regionId.startsWith('cn-') && regionId !== 'cn-hongkong');
  }

  /** 获取 CDT 流量 (GB)。国内/海外流量按目标实例区域属性过滤 */
  async getTraffic(account: Account): Promise<number> {
    const result = await this.rpc(
      {
        product: 'CDT',
        version: '2021-08-13',
        action: 'ListCdtInternetTraffic',
        host: 'cdt.aliyuncs.com',
        regionId: 'cn-hongkong',
      },
      account.access_key_id,
      account.access_key_secret,
    );

    const details = result.TrafficDetails || [];
    if (!details.length && !result.TrafficDetails) {
      throw new Error('API 响应缺少 TrafficDetails 字段');
    }
    const isTargetOverseas = this.isOverseas(account.region_id);
    let total = 0;
    for (const d of details) {
      const region = d.BusinessRegionId || '';
      if (this.isOverseas(region) === isTargetOverseas) {
        total += Number(d.Traffic || 0);
      }
    }
    return total / (1024 * 1024 * 1024);
  }

  /** 获取 ECS 实例状态 */
  async getInstanceStatus(account: Account): Promise<string> {
    const query: Record<string, string | number> = { RegionId: account.region_id };
    if (account.instance_id) query.InstanceId = account.instance_id;

    const result = await this.rpc(
      {
        product: 'Ecs',
        version: '2014-05-26',
        action: 'DescribeInstanceStatus',
        host: `ecs.${account.region_id}.aliyuncs.com`,
        regionId: account.region_id,
        query,
      },
      account.access_key_id,
      account.access_key_secret,
    );

    const status = result.InstanceStatuses?.InstanceStatus?.[0]?.Status;
    if (!status) throw new Error('API 响应未找到实例状态 (请检查 Instance ID)');
    return status;
  }

  /** 控制实例开关机 */
  async controlInstance(account: Account, action: 'start' | 'stop', shutdownMode = 'KeepCharging'): Promise<boolean> {
    if (!account.instance_id) throw new Error('未配置 Instance ID');

    const query: Record<string, string | number> = {
      RegionId: account.region_id,
      InstanceId: account.instance_id,
    };
    if (action === 'stop') query.StoppedMode = shutdownMode;

    await this.rpc(
      {
        product: 'Ecs',
        version: '2014-05-26',
        action: action === 'stop' ? 'StopInstance' : 'StartInstance',
        host: `ecs.${account.region_id}.aliyuncs.com`,
        regionId: account.region_id,
        query,
        timeout: 15000,
      },
      account.access_key_id,
      account.access_key_secret,
    );
    return true;
  }

  private getBssEndpoint(siteType: string): { regionId: string; host: string } {
    if (siteType === 'international') {
      return { regionId: 'ap-southeast-1', host: 'business.ap-southeast-1.aliyuncs.com' };
    }
    return { regionId: 'cn-hangzhou', host: 'business.aliyuncs.com' };
  }

  /** 查询账户可用余额 */
  async getAccountBalance(account: Account): Promise<{ AvailableAmount: string; Currency: string }> {
    const bss = this.getBssEndpoint(account.site_type || 'china');
    const result = await this.rpc(
      {
        product: 'BssOpenApi',
        version: '2017-12-14',
        action: 'QueryAccountBalance',
        host: bss.host,
        regionId: bss.regionId,
      },
      account.access_key_id,
      account.access_key_secret,
    );
    return {
      AvailableAmount: result.Data?.AvailableAmount ?? '0',
      Currency: result.Data?.Currency ?? 'CNY',
    };
  }

  /** 查询指定实例当月账单 */
  async getInstanceBill(account: Account, billingCycle: string): Promise<{ TotalCost: number; Items: any[] }> {
    const bss = this.getBssEndpoint(account.site_type || 'china');
    const result = await this.rpc(
      {
        product: 'BssOpenApi',
        version: '2017-12-14',
        action: 'DescribeInstanceBill',
        host: bss.host,
        regionId: bss.regionId,
        query: { BillingCycle: billingCycle, InstanceID: account.instance_id, Granularity: 'MONTHLY' },
        timeout: 15000,
      },
      account.access_key_id,
      account.access_key_secret,
    );

    const items = result.Data?.Items || [];
    let total = 0;
    const details = items.map((item: any) => {
      const cost = Number(item.PretaxAmount || 0);
      total += cost;
      return {
        ProductName: item.ProductName || '',
        ProductCode: item.ProductCode || '',
        BillingType: item.BillingType || '',
        PretaxAmount: cost,
        DeductedByCashCoupons: Number(item.DeductedByCashCoupons || 0),
        DeductedByPrepaidCard: Number(item.DeductedByPrepaidCard || 0),
        PaymentAmount: Number(item.PaymentAmount || 0),
      };
    });
    return { TotalCost: Math.round(total * 100) / 100, Items: details };
  }

  /** 查询账单总览（按产品分类） */
  async getBillOverview(account: Account, billingCycle: string): Promise<{ TotalCost: number; Products: any[] }> {
    const bss = this.getBssEndpoint(account.site_type || 'china');
    const result = await this.rpc(
      {
        product: 'BssOpenApi',
        version: '2017-12-14',
        action: 'QueryBillOverview',
        host: bss.host,
        regionId: bss.regionId,
        query: { BillingCycle: billingCycle },
        timeout: 15000,
      },
      account.access_key_id,
      account.access_key_secret,
    );

    const items = result.Data?.Items?.Item || [];
    let total = 0;
    const products = [];
    for (const item of items) {
      const cost = Number(item.PretaxAmount || 0);
      if (cost <= 0) continue;
      total += cost;
      products.push({
        ProductName: item.ProductName || '',
        ProductCode: item.ProductCode || '',
        PretaxAmount: Math.round(cost * 100) / 100,
        PaymentAmount: Math.round(Number(item.PaymentAmount || 0) * 100) / 100,
      });
    }
    products.sort((a, b) => b.PretaxAmount - a.PretaxAmount);
    return { TotalCost: Math.round(total * 100) / 100, Products: products };
  }
}
