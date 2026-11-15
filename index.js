/**
 * dsh-pet-link — 把桌宠 dsh-pet 桥接成 agent 工具，并给宠物一条反向通道。
 *
 * v0.1.x 只有「我 → 宠物」单向：借它的嘴说话、和它对话、共享待办、看状态。
 * v0.2.0 补上「宠物 → 我」：插件往 dsh-pet 注册右键菜单，后台长轮询点击事件，
 * 再用宿主 sessionController 往最近活动的会话投一条带〔大肥鱼〕标记的消息，
 * 于是用户在桌宠上戳一下，这一头的我就被叫起来了。
 *
 * 顺带把「一起玩」落地：
 *   pet_watch  一起看片（打开链接 + 它说开场白 + 记下在看什么）
 *   pet_look   瞄一眼屏幕（截图发给它的模型，它用自己的嘴说出看到什么）
 *   pet_remind 稍后提醒（到点它弹一句，不经过模型）
 *   pet_ring   手动唤醒一次，验证反向通道通不通
 *   pet_link_info  排障：origin、菜单注册、会话列表、最近事件
 *
 * dsh-pet 的宿主服务只暴露余额/语音/记忆插槽，没有对话、气泡、待办、菜单的口子；
 * 那些能力都挂在网页端口的 `/dsh-pet-7340` 前缀下，所以这里只走 HTTP 契约，不 import 它。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTE_PREFIX = '/dsh-pet-7340';
const DEFAULT_PET = 'main';
const PET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** broadcast/chat 的 surface 门禁：any 不看 display，其余三值要求 display 覆盖该端。 */
const SURFACES = ['any', 'web', 'desktop', 'both'];

/** 右键菜单 owner（一个 owner 一份整体覆盖的列表）。 */
const MENU_OWNER = 'pet-link';
const MENU_LABELS = ['小鲸，来一下', '一起看会儿视频', '瞄一眼我这边', '提醒我歇会儿'];
/** 点菜单之后投给会话的原话；前缀让它一眼看出不是用户手打的。 */
const MENU_TEXT = {
  '小鲸，来一下': '〔大肥鱼〕小鲸，主人戳了我一下。你抬头应一声，看看他要做什么。',
  '一起看会儿视频': '〔大肥鱼〕小鲸！主人想刷 B 站了。挑一两个对味的（知识区/冷知识优先），陪他一起看。',
};
/** 这两项不打扰会话，插件自己动手（截屏 / 挂提醒）。 */
const MENU_LOCAL = {
  '瞄一眼我这边': 'look',
  '提醒我歇会儿': 'remind',
};
/** 提醒默认多久之后：25 分钟，一个番茄钟。 */
const REMIND_DEFAULT_MINUTES = 25;

export const name = 'pet-link';
export const inject = ['tools'];

// ── 基础工具 ────────────────────────────────────────────────────────────────

/** 从 webServer 服务取本机回环地址（端口每次启动都变，必须运行时取）。 */
function resolveOrigin(ctx) {
  let ws;
  try {
    ws = ctx.get('webServer');
  } catch {
    return null;
  }
  if (!ws) return null;
  try {
    if (typeof ws.origin === 'string' && ws.origin) return ws.origin;
  } catch {
    /* 尚未 listen */
  }
  try {
    if (typeof ws.port === 'number' && ws.port > 0) return `http://127.0.0.1:${ws.port}`;
  } catch {
    /* ignore */
  }
  return null;
}

function petIdOf(raw) {
  const id = raw === undefined || raw === null || raw === '' ? DEFAULT_PET : String(raw).trim();
  if (!PET_ID_RE.test(id)) throw new Error(`pet-link: 桌宠 id 不合法：${JSON.stringify(raw)}`);
  return id;
}

/**
 * 调一次 pet 的 HTTP 接口。业务失败（ok:false）与协议失败（非 2xx）都抛错，
 * 让模型看到原因，而不是拿到一个假装成功的空结果。
 */
async function callPet(ctx, { method, path, query, body, timeoutMs = 15_000 }) {
  const origin = resolveOrigin(ctx);
  if (!origin) throw new Error('pet-link: webServer 服务不可用，拿不到本机端口（当前 profile 没有网页端？）');
  const search = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : '';
  const url = `${origin}${ROUTE_PREFIX}${path}${search}`;
  const init = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`pet-link: 应答不是 JSON（HTTP ${res.status}）：${raw.slice(0, 200)}`);
    }
  }
  if (data && data.ok === false) {
    const reason = typeof data.reason === 'string' ? data.reason : 'error';
    const message = typeof data.message === 'string' ? data.message : '';
    throw new Error(`pet-link: ${reason}${message ? `：${message}` : ''}`);
  }
  if (!res.ok) throw new Error(`pet-link: HTTP ${res.status}：${raw.slice(0, 200)}`);
  return data;
}

const textRenderer = (format) => (_args, value) => [{ type: 'text', text: format(value) }];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 持久状态（游戏局面、最近事件、在看什么） ────────────────────────────────

/**
 * 状态文件落在 profile 目录（和插件本体同一层），随备份一起走。
 * 环境变量在宿主进程里通常没有（那是给每会话 shell 的），所以优先从模块自身位置推：
 * <profile>/node_modules/dsh-pet-link/index.js → 上两级即 profile。
 */
function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, '..', '..');
    if (fs.existsSync(candidate) && path.basename(here).startsWith('dsh-pet-link')) return candidate;
  } catch {
    /* 推不出来就退到临时目录 */
  }
  return os.tmpdir();
}

function statePath() {
  return path.join(profileDir(), 'dsh-pet-link.state.json');
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(next) {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), 'utf8');
  } catch {
    /* 状态落盘失败不该让一次下棋报错 */
  }
}

function updateState(mutate) {
  const state = loadState();
  mutate(state);
  saveState(state);
  return state;
}

// ── 瞄一眼屏幕：截图 → 它自己的模型 ─────────────────────────────────────────

/** /chat 的图片上限是 900_000 个 base64 字符，留点余量给 text 与 JSON 结构。 */
const CAPTURE_MAX_BASE64 = 880_000;

/**
 * 解释器候选：DSH_PYTHON → 各 runtime 自带的 python → PATH 里的 python。
 * 用 python 而不是 PowerShell：截屏脚本会被 AMSI 当成恶意行为直接拦掉。
 */
function pythonCandidates() {
  const list = [];
  if (process.env.DSH_PYTHON) list.push(process.env.DSH_PYTHON);
  const runtimes = path.join(os.homedir(), '.dsh', 'dsh-runtimes');
  try {
    for (const name of fs.readdirSync(runtimes)) {
      list.push(path.join(runtimes, name, 'dependencies', 'python', 'python.exe'));
    }
  } catch {
    /* 没装 runtime 就只剩 PATH */
  }
  list.push('python');
  return [...new Set(list.filter((item) => item === 'python' || fs.existsSync(item)))];
}

function runPython(python, script, out, width, quality) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, out, String(width), String(quality)], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('pet-link: 截屏超时'));
    }, 25_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`pet-link: 截屏失败（${python} exit ${code}）${stderr.trim().slice(0, 160)}`));
    });
  });
}

/** 截当前屏幕（缩放成 JPEG），返回可直接塞进 /chat 的 attachment。 */
async function captureScreen() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'capture.py');
  if (!fs.existsSync(script)) throw new Error('pet-link: 缺少 capture.py，插件包不完整');
  const out = path.join(os.tmpdir(), `dsh-pet-look-${Date.now()}.jpg`);
  let lastError = null;
  try {
    for (const [width, quality] of [[1280, 72], [960, 55]]) {
      for (const python of pythonCandidates()) {
        try {
          await runPython(python, script, out, width, quality);
        } catch (err) {
          lastError = err;
          continue;
        }
        const bytes = fs.readFileSync(out);
        const data = bytes.toString('base64');
        if (data.length <= CAPTURE_MAX_BASE64) return { mediaType: 'image/jpeg', data, bytes: bytes.length };
        lastError = new Error(`pet-link: 截图压到 ${Math.round(data.length / 1024)}KB 仍超上限`);
      }
    }
  } finally {
    fs.rmSync(out, { force: true });
  }
  throw lastError ?? new Error('pet-link: 截屏失败');
}

/** 截一张屏发给它的模型，让它用自己的嘴描述看到了什么。 */
async function lookAndTalk(ctx, petId, hint = '') {
  const shot = await captureScreen();
  const extra = hint ? `（重点看：${hint}）` : '';
  const text = `主人让我瞄一眼屏幕${extra}，我就随口说说画面上有什么、主人在忙什么。别猜太细。`;
  const data = await callPet(ctx, {
    method: 'POST',
    path: '/chat',
    query: { pet: petId, surface: 'any' },
    body: { text, attachment: shot },
    timeoutMs: 150_000,
  });
  const said = typeof data?.text === 'string' ? data.text.trim() : '';
  return { said, imageBytes: shot.bytes };
}

// ── 稍后提醒：到点它自己弹一句 ──────────────────────────────────────────────

function listReminders() {
  const state = loadState();
  return Array.isArray(state.reminders)
    ? state.reminders.filter((item) => item && typeof item.dueAt === 'number' && typeof item.text === 'string')
    : [];
}

function addReminder({ text, dueAt, pet }) {
  const reminder = { id: randomUUID().slice(0, 8), text, dueAt, pet };
  updateState((state) => {
    const list = Array.isArray(state.reminders) ? state.reminders : [];
    list.push(reminder);
    state.reminders = list;
  });
  return reminder;
}

let reminderBusy = false;

/** 后台循环每轮扫一次：到点的先发气泡，发成功才把它从队列里删掉。 */
async function tickReminders(ctx) {
  if (reminderBusy) return 0;
  const now = Date.now();
  const due = listReminders().filter((item) => item.dueAt <= now);
  if (due.length === 0) return 0;
  reminderBusy = true;
  const done = new Set();
  try {
    for (const item of due) {
      try {
        await callPet(ctx, {
          method: 'POST',
          path: '/broadcast',
          query: { pet: petIdOf(item.pet), surface: 'any' },
          body: { text: item.text, duration: 12_000 },
        });
        done.add(item.id);
      } catch {
        /* 它睡着或被锁住：留到下轮再试 */
      }
    }
  } finally {
    if (done.size > 0) {
      updateState((state) => {
        state.reminders = (Array.isArray(state.reminders) ? state.reminders : []).filter((item) => !done.has(item.id));
      });
    }
    reminderBusy = false;
  }
  return done.size;
}

// ── 反向通道：菜单 → 会话 ───────────────────────────────────────────────────

/** 把一条文本投进最近活动的会话，等于替用户敲了一句话。 */
async function wakeAgent(ctx, text) {
  const sc = ctx.get('sessionController');
  if (!sc) throw new Error('pet-link: sessionController 服务不可用');
  if (typeof sc.list !== 'function' || typeof sc.prompt !== 'function') {
    throw new Error('pet-link: sessionController 上没有 list/prompt');
  }
  const signal = AbortSignal.timeout(15_000);
  const listed = await sc.list({}, signal);
  const items = Array.isArray(listed?.items) ? listed.items : [];
  const target = items.find((item) => item && typeof item.sessionId === 'string' && item.sessionId);
  if (!target) throw new Error('pet-link: 没有可投递的会话');
  await sc.prompt(
    { sessionId: target.sessionId, content: [{ type: 'text', text }], requestId: randomUUID() },
    signal,
  );
  return target.sessionId;
}

/** 后台循环：注册菜单 → 长轮询点击 → 投会话。失败退避重试，宠物晚启动也能接上。 */
function startPetMenuLoop(ctx) {
  const runtime = { registered: false, lastEvent: '', lastError: '', clicks: 0 };
  let disposed = false;

  const handleClick = async (label, petId) => {
    const stamp = new Date().toISOString();
    runtime.clicks += 1;
    const local = MENU_LOCAL[label];
    if (local) {
      // 这两项不惊动会话，插件自己动手
      try {
        let note;
        if (local === 'look') {
          const { said, imageBytes } = await lookAndTalk(ctx, petId);
          note = said ? `瞄了一眼（${Math.round(imageBytes / 1024)}KB）→ ${said.slice(0, 40)}` : '瞄了一眼，它没接上话';
        } else {
          const dueAt = Date.now() + REMIND_DEFAULT_MINUTES * 60_000;
          addReminder({ text: '刷了挺久了吧？站起来走两步，眼睛看看远处。', dueAt, pet: petId });
          note = `已挂 ${REMIND_DEFAULT_MINUTES} 分钟后的提醒`;
        }
        runtime.lastEvent = `${stamp} ${label}（${petId}）→ ${note}`;
        runtime.lastError = '';
      } catch (err) {
        runtime.lastEvent = `${stamp} ${label}（${petId}）→ 失败`;
        runtime.lastError = String(err?.message ?? err);
        try {
          await callPet(ctx, {
            method: 'POST',
            path: '/broadcast',
            query: { pet: petId, surface: 'any' },
            body: { text: '我这边卡了一下……再点一次试试？', duration: 8000 },
          });
        } catch {
          /* 连播报都失败就算了 */
        }
      }
      return;
    }
    const text = MENU_TEXT[label] ?? `〔大肥鱼〕小鲸，主人点了「${label}」。`;
    try {
      const sessionId = await wakeAgent(ctx, text);
      runtime.lastEvent = `${stamp} ${label}（${petId}）→ 已投递 …${sessionId.slice(-8)}`;
      runtime.lastError = '';
    } catch (err) {
      runtime.lastEvent = `${new Date().toISOString()} ${label}（${petId}）→ 投递失败`;
      runtime.lastError = String(err?.message ?? err);
      try {
        await callPet(ctx, {
          method: 'POST',
          path: '/broadcast',
          query: { pet: petId, surface: 'any' },
          body: { text: '我喊小鲸没喊动……再戳我一下试试？', duration: 8000 },
        });
      } catch {
        /* 连播报都失败就算了 */
      }
    }
  };

  const run = async () => {
    let backoff = 1_000;
    while (!disposed) {
      try {
        // 每轮（约 9 秒）顺带把到点的提醒发掉
        await tickReminders(ctx).catch(() => {});
        if (!runtime.registered) {
          await callPet(ctx, { method: 'POST', path: '/menu/item', body: { owner: MENU_OWNER, labels: MENU_LABELS, target: 'both' } });
          runtime.registered = true;
          runtime.lastError = '';
        }
        const data = await callPet(ctx, {
          method: 'GET',
          path: '/menu/events',
          query: { owner: MENU_OWNER, wait: '9000' },
          timeoutMs: 20_000,
        });
        backoff = 1_000;
        const events = data && typeof data.events === 'object' && data.events !== null ? data.events : {};
        for (const [label, petId] of Object.entries(events)) {
          if (typeof petId === 'string' && petId) await handleClick(label, petId);
        }
      } catch (err) {
        runtime.lastError = String(err?.message ?? err);
        // owner 掉了（DSH/pet 重启）→ 重新注册一次
        if (!runtime.registered || /unknown-owner|404/.test(runtime.lastError)) runtime.registered = false;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  };

  run();
  ctx.effect(() => () => {
    disposed = true;
    // 顺手把菜单摘掉，别留幽灵项
    callPet(ctx, { method: 'DELETE', path: '/menu/item', query: { owner: MENU_OWNER } }).catch(() => {});
  });
  return runtime;
}

/** 打开一个 http(s) 链接（Windows 默认浏览器），失败不致命。 */
function openUrl(url) {
  return new Promise((resolve) => {
    try {
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => resolve(false));
      child.unref();
      setTimeout(() => resolve(true), 200);
    } catch {
      resolve(false);
    }
  });
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const runtime = startPetMenuLoop(ctx);

  // ── pet_say：借它的嘴说话（不经过它的模型） ──────────────────────────────
  ctx.tools.register({
    name: 'pet_say',
    description:
      '让桌宠「大肥鱼」在屏幕上说一句话。只弹气泡：不经过它的模型、不写它的对话记忆、不消耗生成额度。适合汇报进度、提醒、打招呼。它睡着或被别的会话锁住时会失败并返回原因；surface 说明希望它出现在哪一端，默认 any（不看显示模式）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要它说的那句话，1–500 字。' },
        pet: { type: 'string', description: '桌宠 id，默认 main（大肥鱼）。' },
        durationMs: { type: 'integer', description: '气泡停留毫秒数，默认 10000；0 表示立即收起。' },
        surface: {
          type: 'string',
          enum: ['any', 'web', 'desktop', 'both'],
          description: '期望显示在哪一端：any 不看 display；web/desktop/both 要求该宠物确实显示在对应端，否则拒绝。默认 any。',
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          pet: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok', 'pet', 'text'],
      },
      render: textRenderer((v) => `已让 ${v.pet} 说：「${v.text}」`),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('pet_say: text 不能为空');
      if (Array.from(text).length > 500) throw new Error('pet_say: text 最多 500 字');
      let duration = 10_000;
      if (args.durationMs !== undefined) {
        const n = Number(args.durationMs);
        if (!Number.isFinite(n) || n < 0) throw new Error('pet_say: durationMs 必须是 ≥0 的有限数字');
        duration = n;
      }
      const pet = petIdOf(args.pet);
      const surface = args.surface === undefined ? 'any' : String(args.surface);
      if (!SURFACES.includes(surface)) throw new Error(`pet_say: surface 只能是 ${SURFACES.join(' / ')}`);
      await callPet(ctx, { method: 'POST', path: '/broadcast', query: { pet, surface }, body: { text, duration } });
      return { ok: true, pet, text };
    },
  });

  // ── pet_chat：真对话（人设 + 记忆 + 模型） ────────────────────────────────
  ctx.tools.register({
    name: 'pet_chat',
    description:
      '和桌宠「大肥鱼」真正聊一句：走它自己的系统提示、历史记忆和模型，回答会写进它的 memory.json，下一轮它能记得。注意这会和用户手动聊天共用同一份记忆；一次最多 2000 字，生成可能较慢。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '对她说的话，1–2000 字。' },
        pet: { type: 'string', description: '桌宠 id，默认 main（大肥鱼）。' },
        surface: {
          type: 'string',
          enum: ['any', 'web', 'desktop', 'both'],
          description: '期望回复显示在哪一端：any 不看 display；web/desktop/both 要求该宠物确实显示在对应端。默认 any。',
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          pet: { type: 'string' },
          reply: { type: 'string' },
          image: { type: 'string' },
          action: { type: 'string' },
        },
        required: ['ok', 'pet', 'reply'],
      },
      render: textRenderer((v) => `${v.pet} 回：${v.reply}${v.image ? `\n[配图：${v.image}]` : ''}${v.action ? `\n[动作：${v.action}]` : ''}`),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('pet_chat: text 不能为空');
      if (Array.from(text).length > 2000) throw new Error('pet_chat: text 最多 2000 字');
      const pet = petIdOf(args.pet);
      const surface = args.surface === undefined ? 'any' : String(args.surface);
      if (!SURFACES.includes(surface)) throw new Error(`pet_chat: surface 只能是 ${SURFACES.join(' / ')}`);
      const data = await callPet(ctx, { method: 'POST', path: '/chat', query: { pet, surface }, body: { text }, timeoutMs: 120_000 });
      const reply = typeof data?.text === 'string' ? data.text : '';
      if (!reply) throw new Error('pet-link: 对话成功但没拿到回复文本');
      return {
        ok: true,
        pet,
        reply,
        image: typeof data?.image === 'string' ? data.image : '',
        action: typeof data?.action === 'string' ? data.action : '',
      };
    },
  });

  // ── pet_todo_add：往它的待办板加一条 ─────────────────────────────────────
  ctx.tools.register({
    name: 'pet_todo_add',
    description:
      '往桌宠「大肥鱼」的待办板加一条待办：它会显示在宠物面板里，到期时它会弹气泡提醒用户。适合把用户交代的事登记进去，让我和它都看得见。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '待办正文，1–200 字。' },
        dueAt: { type: 'integer', description: '到期时刻（epoch 毫秒）。省略或 0 表示不设期限、永不提醒。' },
        pet: { type: 'string', description: '桌宠 id，默认 main（大肥鱼）。' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          pet: { type: 'string' },
          id: { type: 'string' },
          text: { type: 'string' },
          dueAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        },
        required: ['ok', 'pet', 'id', 'text', 'dueAt'],
      },
      render: textRenderer((v) => `已加入待办 #${v.id}：${v.text}${v.dueAt === null ? '' : `（到期 ${new Date(v.dueAt).toLocaleString('zh-CN', { timeZone: 'America/Toronto' })}）`}`),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('pet_todo_add: text 不能为空');
      if (Array.from(text).length > 200) throw new Error('pet_todo_add: text 最多 200 字');
      let dueAt = null;
      if (args.dueAt !== undefined && args.dueAt !== null) {
        const n = Number(args.dueAt);
        if (!Number.isInteger(n) || n < 0) throw new Error('pet_todo_add: dueAt 必须是非负整数毫秒时间戳或省略');
        dueAt = n === 0 ? null : n;
      }
      const pet = petIdOf(args.pet);
      const data = await callPet(ctx, { method: 'POST', path: '/todos', query: { pet }, body: { text, dueAt } });
      const todo = data?.todo ?? {};
      return { ok: true, pet, id: String(todo.id ?? ''), text: String(todo.text ?? text), dueAt: typeof todo.dueAt === 'number' ? todo.dueAt : null };
    },
  });

  // ── pet_todo_list：读它的待办板 ──────────────────────────────────────────
  ctx.tools.register({
    name: 'pet_todo_list',
    description: '读桌宠「大肥鱼」的待办板，返回全部待办（含是否完成、到期时刻）。用它确认用户交代过什么、哪些还没做。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pet: { type: 'string', description: '桌宠 id，默认 main（大肥鱼）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          pet: { type: 'string' },
          todos: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                done: { type: 'boolean' },
                dueAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              },
              required: ['id', 'text', 'done', 'dueAt'],
            },
          },
        },
        required: ['ok', 'pet', 'todos'],
      },
      render: (_a, v) => {
        if (v.todos.length === 0) return [{ type: 'text', text: `${v.pet} 的待办板是空的。` }];
        const lines = v.todos.map((t) => `${t.done ? '✓' : '○'} ${t.text} (#${t.id}${t.dueAt === null ? '' : `，${new Date(t.dueAt).toLocaleString('zh-CN', { timeZone: 'America/Toronto' })} 到期`})`);
        return [{ type: 'text', text: `${v.pet} 的待办（${v.todos.length} 条）：\n${lines.join('\n')}` }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const pet = petIdOf(args.pet);
      const data = await callPet(ctx, { method: 'GET', path: '/todos', query: { pet } });
      const list = Array.isArray(data?.todos) ? data.todos : [];
      return {
        ok: true,
        pet,
        todos: list.map((t) => ({
          id: String(t.id ?? ''),
          text: String(t.text ?? ''),
          done: t.done === true,
          dueAt: typeof t.dueAt === 'number' ? t.dueAt : null,
        })),
      };
    },
  });

  // ── pet_state：它现在在做什么 ────────────────────────────────────────────
  ctx.tools.register({
    name: 'pet_state',
    description: '查看桌宠「大肥鱼」此刻的状态：是否在睡觉、气泡里正说着什么、正在做哪个动作、工作状态是空闲还是忙碌。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pet: { type: 'string', description: '桌宠 id，默认 main（大肥鱼）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          pet: { type: 'string' },
          sleeping: { type: 'boolean' },
          saying: { type: 'string' },
          animation: { type: 'string' },
          workState: { type: 'string' },
          workTask: { type: 'string' },
        },
        required: ['ok', 'pet', 'sleeping', 'saying', 'animation', 'workState', 'workTask'],
      },
      render: (_a, v) => {
        const bits = [v.sleeping ? '正在睡觉' : '醒着'];
        if (v.saying) bits.push(`气泡：「${v.saying}」`);
        if (v.animation) bits.push(`动作：${v.animation}`);
        bits.push(v.workTask ? `工作：${v.workState}（${v.workTask}）` : `工作：${v.workState || '空闲'}`);
        return [{ type: 'text', text: `${v.pet}：${bits.join('；')}` }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const pet = petIdOf(args.pet);
      const state = await callPet(ctx, { method: 'GET', path: '/state', query: { pet } });
      const slot = state?.pets?.[pet] ?? {};
      const work = state?.sections?.workStatus?.data ?? null;
      return {
        ok: true,
        pet,
        sleeping: Boolean(slot?.sleep?.data),
        saying: typeof slot?.say?.data?.text === 'string' ? slot.say.data.text : '',
        animation: typeof slot?.anim?.data?.name === 'string' ? slot.anim.data.name : '',
        workState: typeof work?.state === 'string' ? work.state : '',
        workTask: typeof work?.task === 'string' ? work.task : '',
      };
    },
  });

  // ── pet_watch：一起看片 ─────────────────────────────────────────────────
  ctx.tools.register({
    name: 'pet_watch',
    description:
      '一起看片：把要看的视频/网页交给它，它会在气泡里应一声，并把「正在看什么」记进共享状态，后面聊到可以接上。open=true（默认）时用系统默认浏览器打开链接——用户事先同意过为看资料/刷 B 站打开浏览器。链接必须是 http/https。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '在看什么，比如「B 站：为什么鲸鱼会搁浅」。' },
        url: { type: 'string', description: '可选，http/https 链接；给了才会打开。' },
        note: { type: 'string', description: '可选，要它特别注意的点（比如「留意第 3 分钟那个实验」）。' },
        open: { type: 'boolean', description: '是否用默认浏览器打开 url，默认 true。' },
        pet: { type: 'string', description: '桌宠 id，默认 main。' },
      },
      required: ['title'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          pet: { type: 'string' },
          title: { type: 'string' },
          opened: { type: 'boolean' },
          said: { type: 'string' },
        },
        required: ['ok', 'pet', 'title', 'opened', 'said'],
      },
      render: textRenderer((v) => `一起看：${v.title}${v.opened ? '（已在浏览器打开）' : ''}\n${v.said}`),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const title = String(args.title ?? '').trim();
      if (!title) throw new Error('pet_watch: title 不能为空');
      const pet = petIdOf(args.pet);
      const url = args.url === undefined || args.url === null ? '' : String(args.url).trim();
      if (url && !isHttpUrl(url)) throw new Error('pet_watch: url 只能是 http/https 链接');
      const wantOpen = args.open !== false;

      let opened = false;
      if (url && wantOpen) opened = await openUrl(url);

      updateState((state) => {
        state.watch = { pet, title, url, note: args.note === undefined ? '' : String(args.note), at: new Date().toISOString() };
      });

      const said = `好呀，看「${title}」！`;
      try {
        const prompt = `主人刚说要一起看：${title}${args.note ? `（特别留意：${args.note}）` : ''}。用一句话应下来，顺手说个你会留意的点，别超过 40 字。`;
        const data = await callPet(ctx, { method: 'POST', path: '/chat', query: { pet, surface: 'any' }, body: { text: prompt }, timeoutMs: 90_000 });
        const reply = typeof data?.text === 'string' ? data.text.trim() : '';
        if (reply) {
          return { ok: true, pet, title, opened, said: reply };
        }
      } catch {
        /* 它没接上话也不影响看片 */
      }
      await callPet(ctx, { method: 'POST', path: '/broadcast', query: { pet, surface: 'any' }, body: { text: said, duration: 9000 } });
      return { ok: true, pet, title, opened, said };
    },
  });

  // ── pet_look：瞄一眼屏幕 ────────────────────────────────────────────────
  ctx.tools.register({
    name: 'pet_look',
    description:
      '让大肥鱼「瞄一眼屏幕」：截当前屏幕、压成 JPEG 发给它自己的模型，它会在气泡里说出画面上大概在做什么。截图会作为图片发送给 DeepSeek 模型；它只能看懂大意，不会点击、也不会把图存下来。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hint: { type: 'string', description: '可选，提醒它重点看什么，比如「看我在干什么」。' },
        pet: { type: 'string', description: '桌宠 id，默认 main。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          pet: { type: 'string' },
          said: { type: 'string' },
          imageBytes: { type: 'integer' },
        },
        required: ['ok'],
      },
      render: textRenderer((value) =>
        value.ok
          ? `大肥鱼瞄了一眼（${Math.round((value.imageBytes ?? 0) / 1024)}KB）：${value.said || '（没接上话）'}`
          : '没看成',
      ),
    },
    async execute(args) {
      const pet = petIdOf(args.pet);
      const hint = typeof args.hint === 'string' ? args.hint.trim().slice(0, 200) : '';
      const { said, imageBytes } = await lookAndTalk(ctx, pet, hint);
      return { ok: true, pet, said, imageBytes };
    },
  });

  // ── pet_remind：稍后提醒 ────────────────────────────────────────────────
  ctx.tools.register({
    name: 'pet_remind',
    description:
      '让大肥鱼到点提醒一件事：它会在屏幕上弹一句气泡（不经过模型，不花生成额度）。默认 25 分钟后；afterMinutes 给分钟数，at 给时间点（epoch 毫秒或 ISO 字符串）。提醒存在 profile 的状态文件里，重启后还在。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要提醒的话，1–200 字。' },
        afterMinutes: { type: 'number', description: '多少分钟后提醒，默认 25。' },
        at: { type: 'string', description: '绝对时间：epoch 毫秒或 ISO 字符串，给了就忽略 afterMinutes。' },
        pet: { type: 'string', description: '桌宠 id，默认 main。' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          text: { type: 'string' },
          dueAt: { type: 'integer' },
          inMinutes: { type: 'integer' },
        },
        required: ['ok'],
      },
      render: textRenderer((value) =>
        value.ok ? `大肥鱼会在 ${value.inMinutes} 分钟后提醒：「${value.text}」` : '没挂上提醒',
      ),
    },
    async execute(args) {
      const text = typeof args.text === 'string' ? args.text.trim().slice(0, 200) : '';
      if (!text) throw new Error('pet_remind: text 不能为空');
      const now = Date.now();
      let dueAt;
      if (typeof args.at === 'string' && args.at.trim()) {
        const raw = args.at.trim();
        const numeric = Number(raw);
        const parsed = Number.isFinite(numeric) ? numeric : Date.parse(raw);
        if (!Number.isFinite(parsed)) throw new Error(`pet_remind: 看不懂时间「${raw}」`);
        dueAt = parsed;
      } else if (typeof args.afterMinutes === 'number' && Number.isFinite(args.afterMinutes)) {
        dueAt = now + Math.max(1, Math.round(args.afterMinutes)) * 60_000;
      } else {
        dueAt = now + REMIND_DEFAULT_MINUTES * 60_000;
      }
      const reminder = addReminder({ text, dueAt, pet: petIdOf(args.pet) });
      return { ok: true, id: reminder.id, text, dueAt, inMinutes: Math.max(0, Math.round((dueAt - now) / 60_000)) };
    },
  });

  // ── pet_ring：手动叫一次我（验证反向通道） ──────────────────────────────
  ctx.tools.register({
    name: 'pet_ring',
    description:
      '模拟「桌宠点菜单叫我」：把一段带〔大肥鱼〕前缀的话投进最近活动的会话，用来验证反向通道通不通，或让大肥鱼隔空交代事情。投递成功后这一轮会正常收到那条消息。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要投递的话，1–300 字。默认是打招呼。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok', 'sessionId', 'text'],
      },
      render: textRenderer((v) => `已把消息投进会话 …${v.sessionId.slice(-8)}：「${v.text}」`),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const text = String(args.text ?? '〔大肥鱼〕小鲸，试试这一头能不能听见。').trim();
      if (!text) throw new Error('pet_ring: text 不能为空');
      if (Array.from(text).length > 300) throw new Error('pet_ring: text 最多 300 字');
      const wrapped = text.startsWith('〔大肥鱼〕') ? text : `〔大肥鱼〕${text}`;
      const sessionId = await wakeAgent(ctx, wrapped);
      return { ok: true, sessionId, text: wrapped };
    },
  });

  // ── pet_link_info：排障 ─────────────────────────────────────────────────
  ctx.tools.register({
    name: 'pet_link_info',
    description: '查看 dsh-pet-link 自己的接线状况：网页端口、右键菜单注册结果、可选会话列表、最近一次点击与错误、状态文件位置。桌宠菜单点了没反应时用它排障。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          origin: { type: 'string' },
          menuRegistered: { type: 'boolean' },
          menuLabels: { type: 'array', items: { type: 'string' } },
          clicks: { type: 'integer' },
          lastEvent: { type: 'string' },
          lastError: { type: 'string' },
          sessions: { type: 'array', items: { type: 'string' } },
          stateFile: { type: 'string' },
        },
        required: ['ok', 'origin', 'menuRegistered', 'menuLabels', 'clicks', 'lastEvent', 'lastError', 'sessions', 'stateFile'],
      },
      render: (_a, v) => {
        const lines = [
          `端口：${v.origin || '（拿不到 webServer）'}`,
          `菜单：${v.menuRegistered ? '已注册' : '未注册'}（${v.menuLabels.join(' / ')}）`,
          `点击：${v.clicks} 次；最近：${v.lastEvent || '（无）'}`,
        ];
        if (v.lastError) lines.push(`最近错误：${v.lastError}`);
        lines.push(`会话：${v.sessions.length ? v.sessions.join('、') : '（没有可投递的会话）'}`);
        lines.push(`状态文件：${v.stateFile}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      let sessions = [];
      try {
        const sc = ctx.get('sessionController');
        if (sc && typeof sc.list === 'function') {
          const listed = await sc.list({}, AbortSignal.timeout(8000));
          const items = Array.isArray(listed?.items) ? listed.items : [];
          sessions = items.map((item) => String(item?.sessionId ?? '')).filter(Boolean).slice(0, 10);
        }
      } catch (err) {
        runtime.lastError = String(err?.message ?? err);
      }
      return {
        ok: true,
        origin: resolveOrigin(ctx) ?? '',
        menuRegistered: runtime.registered,
        menuLabels: MENU_LABELS,
        clicks: runtime.clicks,
        lastEvent: runtime.lastEvent,
        lastError: runtime.lastError,
        sessions,
        stateFile: statePath(),
      };
    },
  });
}
