import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const BOT_SECRET = "test-bot-secret-0123456789abcdef";

// ------------------------------------------------------------------ 工具

async function getFreePort() {
  const server = net.createServer();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  return port;
}

// 模拟 Sub2API：余额接口 + 用量统计接口 + 用户详情接口（注册时间）。
async function startStubSub2api() {
  const state = {
    balances: new Map([["42", 5.2]]),
    createdAt: new Map([["42", new Date(Date.now() - 86_400_000).toISOString()]]),
    spend: 0,
    calls: []
  };

  const server = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) {
      body += chunk;
    }

    state.calls.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");

    const balanceMatch = req.url.match(/^\/api\/v1\/admin\/users\/([^/]+)\/balance$/);

    if (req.method === "POST" && balanceMatch) {
      const userId = decodeURIComponent(balanceMatch[1]);

      if (!state.balances.has(userId)) {
        res.writeHead(404);
        res.end(JSON.stringify({ code: 404, message: "user not found" }));
        return;
      }

      const payload = JSON.parse(body || "{}");
      const amount = Number(payload.balance ?? 0);
      state.balances.set(userId, Number((state.balances.get(userId) + amount).toFixed(2)));
      res.writeHead(200);
      res.end(JSON.stringify({ code: 0, data: { balance: state.balances.get(userId) } }));
      return;
    }

    const userMatch = req.url.match(/^\/api\/v1\/admin\/users\/([^/]+)$/);

    if (req.method === "GET" && userMatch) {
      const userId = decodeURIComponent(userMatch[1]);

      if (!state.balances.has(userId)) {
        res.writeHead(404);
        res.end(JSON.stringify({ code: 404, message: "user not found" }));
        return;
      }

      const created = state.createdAt.get(userId);
      const data = {
        id: /^\d+$/.test(userId) ? Number(userId) : userId,
        balance: state.balances.get(userId)
      };

      if (created !== undefined && created !== null) {
        data.created_at = created;
      }

      res.writeHead(200);
      res.end(JSON.stringify({ code: 0, data }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/admin/dashboard/users-usage") {
      const requested = JSON.parse(body || "{}");
      const ids = (requested.user_ids || []).map((item) => String(item.id ?? item));
      const stats = Object.fromEntries(
        ids.map((id) => [id, { today_actual_cost: state.spend }])
      );
      res.writeHead(200);
      res.end(JSON.stringify({ code: 0, data: { stats } }));
      return;
    }

    if (req.method === "GET" && req.url === "/api/v1/auth/me") {
      res.writeHead(200);
      res.end(JSON.stringify({ code: 0, data: { id: 42, username: "alice" } }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ code: 404, message: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    state,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务进程提前退出：${output()}`);
    }

    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      // 还没起来，继续等
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  throw new Error(`等待服务启动超时：${output()}`);
}

async function createInstance(options = {}) {
  const {
    secret = BOT_SECRET,
    requireSpend = false,
    requiredSpend = 0,
    trialEnabled = true,
    trialAmount = 1,
    trialDays = 3
  } = options;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "qiandao-bot-"));
  const stub = await startStubSub2api();
  const port = await getFreePort();
  let log = "";

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_BASE_PATH: "/",
      SUB2API_BASE_URL: `http://127.0.0.1:${stub.port}`,
      SUB2API_ADMIN_API_KEY: "test-admin-key",
      CHECKIN_ADMIN_PASSWORD: "test-admin-password",
      CHECKIN_DB_FILE: path.join(tempDir, "checkins.db"),
      CHECKIN_UNIT: "USD",
      CHECKIN_TIMEZONE: "Asia/Shanghai",
      CHECKIN_REWARD_MODE: "weighted_random",
      CHECKIN_REWARD_RULES: "0.3:100:连续签到奖励",
      CHECKIN_REQUIRE_DAILY_SPEND: requireSpend ? "true" : "false",
      CHECKIN_REQUIRED_DAILY_SPEND: String(requiredSpend),
      CHECKIN_TRIAL_CREDIT_ENABLED: trialEnabled ? "true" : "false",
      CHECKIN_TRIAL_CREDIT_AMOUNT: String(trialAmount),
      CHECKIN_TRIAL_CREDIT_DAYS: String(trialDays),
      SUB2API_DAILY_SPEND_METHOD: "POST",
      SUB2API_DAILY_SPEND_PATH_TEMPLATE: "/api/v1/admin/dashboard/users-usage",
      SUB2API_DAILY_SPEND_BODY_TEMPLATE: '{"user_ids":[{id}]}',
      SUB2API_DAILY_SPEND_AMOUNT_FIELD: "data.stats.{id}.today_actual_cost",
      SUB2API_DAILY_SPEND_AUTH_VALUE: "test-admin-key",
      BOT_SHARED_SECRET: secret
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    log += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    log += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/healthz`, child, () => log);

  return {
    stub,
    baseUrl,
    log: () => log,
    async bot(method, routePath, { secret: headerSecret = BOT_SECRET, body } = {}) {
      const headers = { Accept: "application/json" };

      if (headerSecret !== null) {
        headers["X-Bot-Secret"] = headerSecret;
      }

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(`${baseUrl}${routePath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      return { status: response.status, json: await response.json() };
    },
    async stop() {
      child.kill();
      await new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", resolve);
      });
      await stub.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

// ------------------------------------------------------------------ 用例

describe("签到服务 bot API（门槛未开启）", () => {
  let instance;

  before(async () => {
    instance = await createInstance();
  });

  after(async () => {
    await instance.stop();
  });

  test("缺少密钥头返回 401 invalid_bot_secret", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/checkin", {
      secret: null,
      body: { userId: "42" }
    });

    assert.equal(status, 401);
    assert.equal(json.ok, false);
    assert.equal(json.error, "invalid_bot_secret");
    assert.ok(json.message);
  });

  test("密钥错误返回 401 invalid_bot_secret", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/checkin", {
      secret: "wrong-secret",
      body: { userId: "42" }
    });

    assert.equal(status, 401);
    assert.equal(json.error, "invalid_bot_secret");
  });

  test("缺少 userId 返回 400 invalid_user_id", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/checkin", {
      body: { userName: "alice" }
    });

    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.equal(json.error, "invalid_user_id");
  });

  test("userId 含非法字符返回 400 invalid_user_id", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/checkin", {
      body: { userId: "42/../etc" }
    });

    assert.equal(status, 400);
    assert.equal(json.error, "invalid_user_id");
  });

  test("首次签到成功并发放余额", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/checkin", {
      body: { userId: "42", userName: "alice" }
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.date, json.entry.date);
    assert.equal(json.unit, "USD");
    assert.equal(json.alreadyCheckedIn, false);
    assert.equal(json.entry.amount, 0.3);
    assert.equal(json.entry.unit, "USD");
    assert.equal(json.entry.rewardLabel, "连续签到奖励");
    assert.equal(json.entry.date, json.date);
    assert.ok(json.entry.createdAt);
    assert.equal(json.eligibility.enabled, false);
    assert.equal(json.eligibility.eligible, true);
    assert.equal(json.eligibility.currentAmount, null);
    assert.equal(json.eligibility.remainingAmount, 0);
    assert.equal(json.user, undefined, "bot 接口不返回 user 字段");
    assert.equal(instance.stub.state.balances.get("42"), 5.5);
  });

  test("重复签到返回 200 且 alreadyCheckedIn 为 true", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/checkin", {
      body: { userId: "42", userName: "alice" }
    });

    assert.equal(status, 200);
    assert.equal(json.alreadyCheckedIn, true);
    assert.equal(json.entry.amount, 0.3);
    assert.equal(instance.stub.state.balances.get("42"), 5.5, "重复签到不应再次发放");
  });

  test("状态查询返回已完成签到", async () => {
    const { status, json } = await instance.bot("GET", "/api/bot/status?userId=42");

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.checkedIn, true);
    assert.equal(json.entry.amount, 0.3);
    assert.equal(json.unit, "USD");
    assert.equal(json.eligibility.enabled, false);
  });

  test("未签到用户的 status 返回 checkedIn:false", async () => {
    const { status, json } = await instance.bot("GET", "/api/bot/status?userId=99");

    assert.equal(status, 200);
    assert.equal(json.checkedIn, false);
    assert.equal(json.entry, null);
  });

  test("Sub2API 用户不存在返回 404 user_not_found", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/checkin", {
      body: { userId: "12345", userName: "ghost" }
    });

    assert.equal(status, 404);
    assert.equal(json.ok, false);
    assert.equal(json.error, "user_not_found");
  });

  test("status 只接受 GET", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/status", {
      body: { userId: "42" }
    });

    assert.equal(status, 405);
    assert.equal(json.ok, false);
    assert.equal(json.error, "method_not_allowed");
  });

  test("checkin 只接受 POST", async () => {
    const { status, json } = await instance.bot("GET", "/api/bot/checkin?userId=42");

    assert.equal(status, 405);
    assert.equal(json.error, "method_not_allowed");
  });

  test("日志包含 source:bot 与 userId，且不含密钥", () => {
    const log = instance.log();

    assert.match(log, /"event":"bot\.checkin"/);
    assert.match(log, /"source":"bot"/);
    assert.match(log, /"userId":"42"/);
    assert.ok(!log.includes(BOT_SECRET), "日志中不能出现机器人密钥");
  });
});

describe("签到服务 bot API（未配置密钥）", () => {
  let instance;

  before(async () => {
    instance = await createInstance({ secret: "" });
  });

  after(async () => {
    await instance.stop();
  });

  test("未配置 BOT_SHARED_SECRET 时返回 403 bot_disabled", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/checkin", {
      secret: null,
      body: { userId: "42" }
    });

    assert.equal(status, 403);
    assert.equal(json.ok, false);
    assert.equal(json.error, "bot_disabled");
  });

  test("启动日志给出 warn 提示", () => {
    assert.match(instance.log(), /missing_bot_shared_secret/);
  });
});

describe("签到服务 bot API（门槛开启）", () => {
  let instance;

  before(async () => {
    instance = await createInstance({ requireSpend: true, requiredSpend: 10 });
  });

  after(async () => {
    await instance.stop();
  });

  test("消费不足返回 403 daily_spend_not_enough 并带差额", async () => {
    instance.stub.state.spend = 3.2;

    const { status, json } = await instance.bot("POST", "/api/bot/checkin", {
      body: { userId: "42", userName: "alice" }
    });

    assert.equal(status, 403);
    assert.equal(json.ok, false);
    assert.equal(json.error, "daily_spend_not_enough");
    assert.equal(json.eligibility.enabled, true);
    assert.equal(json.eligibility.eligible, false);
    assert.equal(json.eligibility.requiredAmount, 10);
    assert.equal(json.eligibility.currentAmount, 3.2);
    assert.equal(json.eligibility.remainingAmount, 6.8);
    assert.equal(instance.stub.state.balances.get("42"), 5.2, "不达标时不应发放余额");
  });

  test("消费达标后可以签到", async () => {
    instance.stub.state.spend = 12.34;

    const { status, json } = await instance.bot("POST", "/api/bot/checkin", {
      body: { userId: "42", userName: "alice" }
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.alreadyCheckedIn, false);
    assert.equal(json.eligibility.enabled, true);
    assert.equal(json.eligibility.eligible, true);
    assert.equal(json.eligibility.currentAmount, 12.34);
    assert.equal(instance.stub.state.balances.get("42"), 5.5);
  });

  test("status 暴露门槛与实际消费", async () => {
    const { status, json } = await instance.bot("GET", "/api/bot/status?userId=42");

    assert.equal(status, 200);
    assert.equal(json.checkedIn, true);
    assert.equal(json.eligibility.enabled, true);
    assert.equal(json.eligibility.requiredAmount, 10);
    assert.equal(json.eligibility.currentAmount, 12.34);
    assert.equal(json.eligibility.remainingAmount, 0);
  });
});

describe("签到服务 bot API（领测试额度）", () => {
  let instance;

  before(async () => {
    instance = await createInstance();
  });

  after(async () => {
    await instance.stop();
  });

  test("注册 3 天内的账号首次领取成功并发放余额", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/trial-credit", {
      body: { userId: "42", userName: "alice" }
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.alreadyClaimed, false);
    assert.equal(json.unit, "USD");
    assert.equal(json.entry.amount, 1);
    assert.equal(json.entry.unit, "USD");
    assert.equal(json.entry.rewardLabel, "测试额度");
    assert.ok(json.entry.createdAt);
    assert.equal(json.eligibility.enabled, true);
    assert.equal(json.eligibility.eligible, true);
    assert.equal(json.eligibility.claimed, true);
    assert.equal(json.eligibility.allowedDays, 3);
    assert.ok(json.eligibility.registeredDays >= 0.9, "注册天数应接近 1 天");
    assert.equal(json.user, undefined, "bot 接口不返回 user 字段");
    assert.equal(instance.stub.state.balances.get("42"), 6.2);
  });

  test("重复领取返回 200 且 alreadyClaimed 为 true，不再发放", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/trial-credit", {
      body: { userId: "42", userName: "alice" }
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.alreadyClaimed, true);
    assert.equal(json.entry.amount, 1);
    assert.equal(json.eligibility.reason, "already_claimed");
    assert.equal(instance.stub.state.balances.get("42"), 6.2, "重复领取不应再次发放");
  });

  test("注册超过 3 天的账号返回 403 trial_window_expired", async () => {
    instance.stub.state.balances.set("77", 0);
    instance.stub.state.createdAt.set("77", new Date(Date.now() - 10 * 86_400_000).toISOString());

    const { status, json } = await instance.bot("POST", "/api/bot/trial-credit", {
      body: { userId: "77", userName: "bob" }
    });

    assert.equal(status, 403);
    assert.equal(json.ok, false);
    assert.equal(json.error, "trial_window_expired");
    assert.equal(json.eligibility.enabled, true);
    assert.equal(json.eligibility.eligible, false);
    assert.equal(json.eligibility.reason, "registration_window_expired");
    assert.equal(json.eligibility.allowedDays, 3);
    assert.ok(json.eligibility.registeredDays > 9.9);
    assert.equal(instance.stub.state.balances.get("77"), 0, "超期不应发放余额");
  });

  test("拿不到注册时间时返回 502 registration_time_unavailable", async () => {
    instance.stub.state.balances.set("88", 0);
    instance.stub.state.createdAt.set("88", null);

    const { status, json } = await instance.bot("POST", "/api/bot/trial-credit", {
      body: { userId: "88", userName: "carol" }
    });

    assert.equal(status, 502);
    assert.equal(json.ok, false);
    assert.equal(json.error, "registration_time_unavailable");
    assert.equal(instance.stub.state.balances.get("88"), 0, "注册时间未知时不能放行");
  });

  test("Sub2API 用户不存在返回 404 user_not_found", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/trial-credit", {
      body: { userId: "12345", userName: "ghost" }
    });

    assert.equal(status, 404);
    assert.equal(json.ok, false);
    assert.equal(json.error, "user_not_found");
  });

  test("缺少 userId 返回 400 invalid_user_id", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/trial-credit", {
      body: { userName: "alice" }
    });

    assert.equal(status, 400);
    assert.equal(json.error, "invalid_user_id");
  });

  test("密钥错误返回 401 invalid_bot_secret", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/trial-credit", {
      secret: "wrong-secret",
      body: { userId: "42" }
    });

    assert.equal(status, 401);
    assert.equal(json.error, "invalid_bot_secret");
  });

  test("trial-credit 只接受 POST", async () => {
    const { status, json } = await instance.bot("GET", "/api/bot/trial-credit?userId=42");

    assert.equal(status, 405);
    assert.equal(json.error, "method_not_allowed");
  });

  test("日志包含 bot.trial_credit 且不含密钥", () => {
    const log = instance.log();

    assert.match(log, /"event":"bot\.trial_credit"/);
    assert.match(log, /"event":"trial_credit\.success"/);
    assert.ok(!log.includes(BOT_SECRET), "日志中不能出现机器人密钥");
  });
});

describe("签到服务 bot API（领测试额度关闭）", () => {
  let instance;

  before(async () => {
    instance = await createInstance({ trialEnabled: false });
  });

  after(async () => {
    await instance.stop();
  });

  test("活动未开启时返回 403 trial_credit_disabled", async () => {
    const { status, json } = await instance.bot("POST", "/api/bot/trial-credit", {
      body: { userId: "42", userName: "alice" }
    });

    assert.equal(status, 403);
    assert.equal(json.ok, false);
    assert.equal(json.error, "trial_credit_disabled");
    assert.equal(json.eligibility.enabled, false);
    assert.equal(instance.stub.state.balances.get("42"), 5.2, "关闭时不应发放余额");
  });

  test("后台开启后可以领取，且金额/天数可自行设置", async () => {
    const response = await fetch(`${instance.baseUrl}/api/admin/config`, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Checkin-Admin-Password": "test-admin-password"
      },
      body: JSON.stringify({
        trialCredit: { enabled: true, amount: 2.5, allowedDays: 7 }
      })
    });
    const updated = await response.json();

    assert.equal(response.status, 200);
    assert.equal(updated.trialCredit.enabled, true);
    assert.equal(updated.trialCredit.amount, 2.5);
    assert.equal(updated.trialCredit.allowedDays, 7);

    const { status, json } = await instance.bot("POST", "/api/bot/trial-credit", {
      body: { userId: "42", userName: "alice" }
    });

    assert.equal(status, 200);
    assert.equal(json.alreadyClaimed, false);
    assert.equal(json.entry.amount, 2.5);
    assert.equal(json.eligibility.allowedDays, 7);
    assert.equal(instance.stub.state.balances.get("42"), 7.7);
  });

  test("后台金额非法时返回 400", async () => {
    const response = await fetch(`${instance.baseUrl}/api/admin/config`, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Checkin-Admin-Password": "test-admin-password"
      },
      body: JSON.stringify({
        trialCredit: { enabled: true, amount: 0, allowedDays: 7 }
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "invalid_trial_credit");
  });
});
