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
 *   pet_ring   手动唤醒一次，验证反向通道通不通
 *   pet_link_info  排障：origin、菜单注册、会话列表、最近事件
 *
 * v0.5.0 收窄工具面：去掉待办板与定时提醒这两个工具（dsh-pet 自己的待办和提醒已经够用，
 * 两套并存只会互相打架），并修两个小毛病：静音之后 on 解不回来、长轮询成功之后旧错误
 * 永远挂在排障信息上。
 *
 * v0.7.0 健康提醒改钟点制：每小时 :00 和 :40 各一次、全天不停，按半夜/白天/夜间三段
 * 换三套话；右键菜单去掉「提醒我歇会儿」——提醒归插件自动做，不再需要手动催。
 *
 * v0.8.0「三人行」：把大肥鱼的对话记忆当成共享聊天记录。
 * dsh-pet 是单轮生成、没有工具，它没法自己调工具叫小鲸；但它说的每句话都落在
 * memory.json 里。所以这里轮询那份记忆：assistant 新回复里带【叫小鲸】标记就
 * wakeAgent 把我叫起来（smart 模式），all 模式每句都叫（90 秒合并节流），off 只记账不叫。
 * pet_inbox 让我随时翻全部对话，pet_trio 切模式；右键菜单补一项「把鱼刚说的递过去」，
 * 手点也能立刻把它的原话搬到我这边。全程只读 dsh-pet 的数据文件，不碰它的代码。
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

import { GRID_TEXT, SLOT_MINUTES, nextSlot, poolFor, segmentLabel } from './schedule.js';

const ROUTE_PREFIX = '/dsh-pet-7340';
const DEFAULT_PET = 'main';
const PET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** broadcast/chat 的 surface 门禁：any 不看 display，其余三值要求 display 覆盖该端。 */
const SURFACES = ['any', 'web', 'desktop', 'both'];

/** 右键菜单 owner（一个 owner 一份整体覆盖的列表）。 */
const MENU_OWNER = 'pet-link';
const MENU_LABELS = ['小鲸，来一下', '把鱼刚说的递过去', '一起看会儿视频', '瞄一眼我这边', '静音 2 小时'];
/** 这项不投固定文案，而是读大肥鱼最后一句原话投过去。 */
const MENU_DELIVER = '把鱼刚说的递过去';
/** 点菜单之后投给会话的原话；前缀让它一眼看出不是用户手打的。 */
const MENU_TEXT = {
  '小鲸，来一下': '〔大肥鱼〕小鲸，主人戳了我一下。你抬头应一声，看看他要做什么。（这是主人在我右键菜单上点的，不是自动消息。）',
  '一起看会儿视频': '〔大肥鱼〕小鲸！主人想刷 B 站了。挑一两个对味的（知识区/冷知识优先），陪他一起看。（这是主人在我右键菜单上点的。）',
};
/** 这两项不打扰会话，插件自己动手（截屏 / 静音）。 */
const MENU_LOCAL = {
  '瞄一眼我这边': 'look',
  '静音 2 小时': 'mute',
};
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

// ── 持久状态（最近事件、在看什么） ──────────────────────────────────────────

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
    /* 状态落盘失败不该让一次读状态报错 */
  }
}

function updateState(mutate) {
  const state = loadState();
  mutate(state);
  saveState(state);
  return state;
}

// ── 三人行：大肥鱼的对话记忆 ↔ 我这头 ─────────────────────────────────────────
//
// dsh-pet 的对话全落在 memory.json：{ <桶>: { <petId>: { messages: [{role,content,ts,...}] } } }。
// 它是单轮生成、没有工具，没法自己调工具叫我；但它说的每句话都在这里。
// 这一节只读那份文件（不碰 dsh-pet 代码，升级不丢）：
//   pollTrio  轮询新增回复，带【叫小鲸】标记就 wakeAgent 叫我；all 模式每句都叫
//   pet_inbox 随时翻全部对话，「未读」按 state.trio.lastReadTs 算
//   pet_trio  切 smart / all / off
// 同步游标用「消息条数」而不是 ts：同一次对话的 user/assistant 可能共用同一个 ts。

/** 唤醒标记：它写【叫小鲸】【〔叫小鲸〕】【[叫小鲸]】都算。 */
const WAKE_MARK_RE = /[【〔\[]\s*叫\s*小鲸\s*[】〕\]]/;
/** 一条递过来的话最多截多长。 */
const TRIO_TEXT_MAX = 800;
/** all 模式两次唤醒之间至少隔多久（合并这一窗口里的多条）。 */
const TRIO_ALL_GAP_MS = 90_000;

/** 记忆文件位置：环境变量 → ~/.dsh/dsh-pet/memory.json（Junction，最稳）→ D 盘小屋。 */
function resolveMemoryPath() {
  const candidates = [];
  if (process.env.DSH_PET_MEMORY) candidates.push(process.env.DSH_PET_MEMORY);
  try {
    candidates.push(path.join(os.homedir(), '.dsh', 'dsh-pet', 'memory.json'));
  } catch {
    /* ignore */
  }
  candidates.push('D:\\DSH_DATA\\大肥鱼\\memory.json');
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return candidates[0] ?? 'memory.json';
}

/** 读某只宠物的对话消息；结构不对/文件缺失一律当空，不让轮询崩。 */
function readChatMessages(petId) {
  const file = resolveMemoryPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, messages: [] };
  }
  let mem;
  try {
    mem = JSON.parse(raw);
  } catch {
    return { file, messages: [] };
  }
  if (!mem || typeof mem !== 'object' || Array.isArray(mem)) return { file, messages: [] };
  for (const bucket of Object.values(mem)) {
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    const leaf = bucket[petId];
    if (leaf && Array.isArray(leaf.messages)) return { file, messages: leaf.messages };
  }
  return { file, messages: [] };
}

function trioState() {
  const state = loadState();
  const trio = state.trio && typeof state.trio === 'object' ? state.trio : {};
  return {
    enabled: trio.enabled !== false,
    mode: trio.mode === 'all' || trio.mode === 'off' ? trio.mode : 'smart',
    cursorCount: Number.isFinite(trio.cursorCount) ? trio.cursorCount : -1,
    lastReadTs: Number.isFinite(trio.lastReadTs) ? trio.lastReadTs : 0,
    lastWakeAt: Number.isFinite(trio.lastWakeAt) ? trio.lastWakeAt : 0,
    woken: Number.isFinite(trio.woken) ? trio.woken : 0,
    lastWakeText: typeof trio.lastWakeText === 'string' ? trio.lastWakeText : '',
    lastError: typeof trio.lastError === 'string' ? trio.lastError : '',
  };
}

function saveTrio(patch) {
  updateState((state) => {
    state.trio = { ...trioState(), ...patch };
  });
}

/** pet_chat 完事后把游标推到最新，免得自己刚问出来的回复又被轮询当成「鱼的来信」。 */
function syncTrioCursor(petId = DEFAULT_PET) {
  const { messages } = readChatMessages(petId);
  if (messages.length) saveTrio({ cursorCount: messages.length });
}

/** 把一条（或几条合并的）鱼的话裁成适合投递的一段。 */
function trioTextOf(messages) {
  const parts = [];
  for (const message of messages) {
    if (!message || typeof message.content !== 'string') continue;
    const flat = message.content.replace(WAKE_MARK_RE, '').replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    parts.push(
      flat.length > TRIO_TEXT_MAX ? `${flat.slice(0, TRIO_TEXT_MAX - 1)}…（全文见 pet_inbox）` : flat,
    );
  }
  return parts.join('\n');
}

/** 后台轮询：把新出现的 assistant 回复按模式处理。失败只记 lastError，不炸循环。 */
async function pollTrio(ctx, runtime) {
  const trio = trioState();
  if (!trio.enabled || trio.mode === 'off') return;
  const { messages } = readChatMessages(DEFAULT_PET);
  if (!messages.length) return;
  if (trio.cursorCount < 0 || messages.length < trio.cursorCount) {
    // 首次运行 / 文件被清空重写：只把游标锚到现在，不补投历史
    saveTrio({ cursorCount: messages.length, lastError: '' });
    return;
  }
  if (messages.length === trio.cursorCount) return;
  const fresh = messages.slice(trio.cursorCount);
  const assistants = fresh.filter(
    (m) => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim(),
  );
  const marked = assistants.filter((m) => WAKE_MARK_RE.test(m.content));
  const wanted = trio.mode === 'all' ? assistants : marked;
  if (!wanted.length) {
    saveTrio({ cursorCount: messages.length });
    return;
  }
  // all 模式：留到节流窗口过去再一起投，未到点就不推进游标
  const now = Date.now();
  if (trio.mode === 'all' && now - trio.lastWakeAt < TRIO_ALL_GAP_MS) return;

  const text = trioTextOf(wanted);
  if (!text) {
    saveTrio({ cursorCount: messages.length });
    return;
  }
  try {
    if (await targetSessionBusy(ctx).catch(() => false)) {
      // 主人那边正忙着：这一轮先不投，游标也不推进，等它闲下来再递
      runtime.lastTrio = `${new Date().toISOString()} 等主人这一轮跑完再递`;
      return;
    }
    const sessionId = await wakeAgent(ctx, `〔大肥鱼〕${text}`);
    saveTrio({
      cursorCount: messages.length,
      lastWakeAt: now,
      woken: trio.woken + 1,
      lastWakeText: text.slice(0, 200),
      lastError: '',
    });
    runtime.lastTrio = `${new Date().toISOString()} 叫醒 …${String(sessionId).slice(-8)}`;
  } catch (err) {
    // 投不进去也推进游标：按「推送失败就跳过」的老规矩，不反复重试
    saveTrio({ cursorCount: messages.length, lastWakeAt: now, lastError: String(err?.message ?? err) });
  }
}


/** 装上的是哪个版本：排障时不用翻 node_modules。 */
function pluginVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : '';
  } catch {
    return '';
  }
}

/** 老版本留在状态文件里的孤儿字段：留着只会长毛，加载时顺手清掉。 */
function migrateState() {
  const state = loadState();
  let dirty = false;
  for (const key of ['games', 'reminders']) {
    if (key in state) {
      delete state[key];
      dirty = true;
    }
  }
  if (dirty) saveState(state);
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

// ── 健康节奏：它自己看表，该歇了就吱一声 ────────────────────────────────────

/**
 * 一天里它会说什么。白天催活动，夜里催收工，半夜劝睡。
 * 按 schedule.js 的钟点网格分段轮换，段与段之间各走各的计数器。
 */
const HEALTH_POOL = {
  day: [
    '喝口温水吧，别干着。',
    '站起来走两步，腰比屏幕重要。',
    '眼睛看远处 20 秒，就 20 秒。',
    '伸个懒腰，肩胛骨往后收一下。',
    '眨几下眼，盯屏幕太久了。',
    '脖子左右各转三下，慢一点。',
    '站起接杯水，顺便把窗户开条缝。',
    '十指张开再握紧，来回五下。',
    '走到窗边看两眼远处的楼。',
    '靠着椅背深呼吸三次，肩膀放下来。',
    '坐着把腿伸直、脚尖勾一勾。',
    '手里这行收个尾，起身再回来。',
  ],
  night: [
    '已经挺晚了，手上这点收个尾就停吧。',
    '该收工了。明天早上脑子清楚，比今晚多熬一小时值。',
    '眼睛酸了吧？关灯躺着比坐着强。',
    '知道你还想多做点，今天到这儿已经够了。',
    '累了就是累了，别硬撑；卡住了也先放着。',
    '关屏幕之前先喝口水，别空着睡。',
    '睡前别再刷手机了，让眼睛真的歇一会儿。',
    '明天的事明天再说，它跑不掉。',
    '我在这儿，但不催你——收工就好。',
  ],
  late: [
    '这个点，是真的该睡了。',
    '别撑了，明天补不回来的。',
    '关电脑，去洗脸，该休息了。',
    '你现在做的这件事，明天做只会更快。',
    '再熬下去就不是努力了，是拿身体换。去睡觉。',
  ],
};

function healthState() {
  const raw = loadState().health;
  const saved = raw && typeof raw === 'object' ? raw : {};
  // v0.7 起每个池各走各的序号；旧状态里的单值 index 当作三个池的起点，迁移无感。
  const legacyIndex = Number.isFinite(saved.index) ? saved.index : 0;
  const rawIndexes = saved.indexByPool && typeof saved.indexByPool === 'object' ? saved.indexByPool : {};
  const pick = (key) => (Number.isFinite(rawIndexes[key]) ? rawIndexes[key] : legacyIndex);
  return {
    enabled: saved.enabled !== false,
    nextAt: Number.isFinite(saved.nextAt) ? saved.nextAt : 0,
    indexByPool: { day: pick('day'), night: pick('night'), late: pick('late') },
    mutedUntil: Number.isFinite(saved.mutedUntil) ? saved.mutedUntil : 0,
    lastAt: Number.isFinite(saved.lastAt) ? saved.lastAt : 0,
    lastText: typeof saved.lastText === 'string' ? saved.lastText : '',
  };
}

function saveHealth(patch) {
  updateState((state) => {
    const prev = healthState();
    const next = { ...prev, ...patch };
    if (patch.indexByPool) next.indexByPool = { ...prev.indexByPool, ...patch.indexByPool };
    state.health = next;
  });
}

/** 三小时没跟 DSH 打过交道，就当人不在；这时候不弹，免得对着空屋子说话。 */
async function someoneAround(ctx) {
  try {
    const sc = ctx.get('sessionController');
    if (!sc || typeof sc.list !== 'function') return true;
    const listed = await sc.list({}, AbortSignal.timeout(8000));
    const items = Array.isArray(listed?.items) ? listed.items : [];
    let newest = 0;
    for (const item of items) {
      const at = Number(item?.updatedAt);
      if (Number.isFinite(at) && at > newest) newest = at;
    }
    return newest === 0 || Date.now() - newest < 180 * 60_000;
  } catch {
    return true;
  }
}

let healthBusy = false;
let healthCheckedAt = 0;

/** 后台循环每轮问一次（60 秒节流）：到点了弹一句，再排下一次。 */
async function tickHealth(ctx, { force = false, ephemeral = false } = {}) {
  const now = Date.now();
  if (healthBusy || (!force && now - healthCheckedAt < 60_000)) return null;
  healthCheckedAt = now;
  const health = healthState();
  if (!health.enabled) return null;
  if (health.mutedUntil > now) return null;
  // 旧版可能留下 22:30、09:00 这种非钟点时间：先对齐到下一个 :00 / :40
  if (health.nextAt && !SLOT_MINUTES.includes(new Date(health.nextAt).getMinutes())) {
    health.nextAt = nextSlot(now);
    saveHealth({ nextAt: health.nextAt });
  }

  if (!health.nextAt) {
    saveHealth({ nextAt: nextSlot(now) });
    // 还没排过表就顺手排上；强行试一句（test）时要继续往下弹，不能在这里空手回去
    if (!force) return null;
  }
  if (!force && health.nextAt > now) return null;
  if (!force && !(await someoneAround(ctx))) {
    // 人不在：不打扰，也不把这一格算成已弹，直接挂到下一个钟点
    saveHealth({ nextAt: nextSlot(now) });
    return null;
  }

  healthBusy = true;
  try {
    const poolName = poolFor(now);
    const pool = HEALTH_POOL[poolName];
    const index = health.indexByPool[poolName] ?? 0;
    const text = pool[index % pool.length];
    await callPet(ctx, {
      method: 'POST',
      path: '/broadcast',
      query: { pet: DEFAULT_PET, surface: 'any' },
      body: { text, duration: 11_000 },
    });
    if (ephemeral) {
      // 试一句不该扰动真节奏：只记下说了什么，不动 nextAt 和轮换序号
      saveHealth({ lastText: text });
    } else {
      saveHealth({
        indexByPool: { [poolName]: index + 1 },
        nextAt: nextSlot(now),
        lastAt: now,
        lastText: text,
      });
    }
    return text;
  } catch {
    // 它睡着或被锁：下一个钟点再来，不占提醒序号
    saveHealth({ nextAt: nextSlot(now) });
    return null;
  } finally {
    healthBusy = false;
  }
}

// ── 眼睛：它自己看表，隔一阵瞄一眼主人 ──────────────────────────────────────
//
// 分工：看（截图）归宿主侧——它没有腿；说什么归它。节奏一分钟一轮的循环里顺带判断，
// 但真正探测/截图只在「到点 + 前台不是会议/视频」时发生，平时几乎零开销。
// 问一下再截：probe.py 只读 GetLastInputInfo / 前台窗口，不碰画面。

const EYE_DEFAULT_INTERVAL_MIN = 15;
const EYE_MIN_INTERVAL_MIN = 10;
const EYE_MAX_INTERVAL_MIN = 30;
/** 到点但主人正在动手 / 在开会，隔这么久再判断一次（不然每 9 秒探一回）。 */
const EYE_RETRY_MS = 5 * 60_000;
/** 学习/工作时降到一半频率：间隔翻倍。 */
const EYE_STUDY_FACTOR = 2;
/** 同一状态十分钟内只说一回（第四条规矩）。 */
const EYE_MIN_GAP_MS = 10 * 60_000;
/** 会议 / 网课 / 共享屏幕一律不看也不说话：屏幕上可能是别人的脸和别人的文档。 */
const EYE_MEETING_EXE =
  /^(zoom|teams|ms-teams|webex|webexmta|meet|skype|wemeet|wemeetapp|tencentmeeting|discord|classin|dingtalk)/i;
const EYE_MEETING_TITLE =
  /(Google Meet|Zoom 会议|Zoom Meeting|腾讯会议|Teams 会议|Webex|ClassIn|雨课堂|钉钉|正在共享|共享屏幕|屏幕共享)/i;
/** 学习 / 工作：写东西、看文献、写代码 —— 说话降到低频。 */
const EYE_STUDY_EXE =
  /^(code|code-insiders|cursor|winword|excel|powerpnt|acrord32|acrobat|sumatrapdf|notepad|notepad\+\+|obsidian|typora|sublime_text|pycharm64|idea64|webstorm64|goland64|clion64|matlab|rstudio|zotero|mstsc|onedrive|onenote)/i;
const EYE_STUDY_TITLE =
  /(Google Docs|Google Sheets|Google Slides|Overleaf|LaTeX|\.tex\b|PDF|Coursera|Canvas|D2L|Brightspace|笔记|作业|论文|讲义|习题)/i;
/** 看视频：算「别打扰」，不看不吭声（主人 2026-11-25 的新规矩）。 */
const EYE_VIDEO_TITLE =
  /(YouTube|哔哩哔哩|bilibili|Netflix|腾讯视频|爱奇艺|优酷|芒果TV|Twitch|Prime Video|Disney\+|VLC|PotPlayer|MPC-HC|播放器|正在播放)/i;
/** 打游戏：正常频率，随便说。 */
const EYE_PLAY_TITLE = /(Steam|Minecraft|英雄联盟|League of Legends|原神|Genshin|CS2|Counter-Strike|VALORANT)/i;

function eyeState() {
  const raw = loadState().eye;
  const eye = raw && typeof raw === 'object' ? raw : {};
  const interval = Number(eye.intervalMinutes);
  return {
    enabled: eye.enabled !== false,
    intervalMinutes: Number.isFinite(interval)
      ? Math.min(EYE_MAX_INTERVAL_MIN, Math.max(EYE_MIN_INTERVAL_MIN, Math.round(interval)))
      : EYE_DEFAULT_INTERVAL_MIN,
    lastEyeAt: Number(eye.lastEyeAt) || 0,
    lastCheckAt: Number(eye.lastCheckAt) || 0,
    lastSaid: typeof eye.lastSaid === 'string' ? eye.lastSaid : '',
    lastSkip: typeof eye.lastSkip === 'string' ? eye.lastSkip : '',
    lastError: typeof eye.lastError === 'string' ? eye.lastError : '',
    lastState: typeof eye.lastState === 'string' ? eye.lastState : '',
    mutedUntil: Number(eye.mutedUntil) || 0,
    fired: Number(eye.fired) || 0,
  };
}

function saveEye(patch) {
  const state = updateState((s) => {
    const cur = s.eye && typeof s.eye === 'object' ? s.eye : {};
    s.eye = { ...cur, ...patch };
  });
  return state.eye;
}

/** 跑 probe.py 拿 {idleSeconds, foreground:{title,exe,pid}}。 */
function runProbe(python) {
  return new Promise((resolve, reject) => {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe.py');
    const child = spawn(python, [script], { windowsHide: true });
    const out = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('pet-link: 环境探测超时'));
    }, 8_000);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`pet-link: 环境探测失败（${python} exit ${code}）${err.trim().slice(0, 160)}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString('utf8')));
      } catch {
        reject(new Error('pet-link: 环境探测输出不是 JSON'));
      }
    });
  });
}

async function probeDesktop() {
  let lastError = null;
  for (const python of pythonCandidates()) {
    try {
      return await runProbe(python);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error('pet-link: 找不到可用的 python');
}

/** 前台属于哪一类：meeting（开会/网课）/ study（学习工作）/ play（游戏视频）/ other / none。 */
function classifyDesktop(probe) {
  const title = String(probe?.foreground?.title ?? '').trim();
  const exeName = String(probe?.foreground?.exe ?? '').split(/[\\/]/).pop().replace(/\.exe$/i, '');
  if (!title) return { state: 'none', reason: '前台没有窗口（锁屏或刚切换）' };
  if (EYE_MEETING_EXE.test(exeName) || EYE_MEETING_TITLE.test(title)) {
    return { state: 'meeting', reason: '主人在开会/上网课' };
  }
  if (EYE_VIDEO_TITLE.test(title)) return { state: 'video', reason: '主人在看视频' };
  if (EYE_PLAY_TITLE.test(title)) return { state: 'play', reason: '' };
  if (EYE_STUDY_EXE.test(exeName) || EYE_STUDY_TITLE.test(title)) return { state: 'study', reason: '' };
  return { state: 'other', reason: '' };
}

/** 这一类的节奏：学习/工作时间隔翻倍，其余按默认。 */
function eyeIntervalMs(eye, state) {
  const minutes = Math.min(
    EYE_MAX_INTERVAL_MIN,
    eye.intervalMinutes * (state === 'study' ? EYE_STUDY_FACTOR : 1),
  );
  return minutes * 60_000;
}

const EYE_STATE_TEXT = {
  study: '主人在学习/干活',
  play: '主人在打游戏',
  video: '主人在看视频',
  other: '主人在用电脑',
};

/** 到点了才探：先问环境，过了闸门才截图+生成。平时几乎零开销。 */
async function eyeTick(ctx, runtime) {
  const eye = eyeState();
  if (!eye.enabled) return false;
  const now = Date.now();
  if (eye.mutedUntil > now) return false;
  if (now - eye.lastCheckAt < EYE_RETRY_MS) return false;
  // 先用最短的节奏挡一道，省掉绝大多数探测
  if (now - eye.lastEyeAt < eye.intervalMinutes * 60_000) return false;
  if (now - eye.lastEyeAt < EYE_MIN_GAP_MS) return false;
  saveEye({ lastCheckAt: now });

  let probe;
  try {
    probe = await probeDesktop();
  } catch (err) {
    const message = String(err?.message ?? err);
    saveEye({ lastError: message });
    if (runtime) runtime.lastEye = `环境探测失败：${message.slice(0, 60)}`;
    return false;
  }

  const kind = classifyDesktop(probe);
  if (kind.state === 'meeting' || kind.state === 'video' || kind.state === 'none') {
    saveEye({ lastSkip: kind.reason, lastError: '', lastState: kind.state });
    if (runtime) runtime.lastEye = `到点了，但${kind.reason}，先不看`;
    return false;
  }
  // 学习/工作要等更久：间隔翻倍
  if (now - eye.lastEyeAt < eyeIntervalMs(eye, kind.state)) {
    saveEye({ lastSkip: '', lastState: kind.state });
    if (runtime) runtime.lastEye = `${EYE_STATE_TEXT[kind.state]}，这一轮按低频跳过`;
    return false;
  }
  const title = String(probe.foreground.title).replace(/\s+/g, ' ').trim().slice(0, 50);
  const where = EYE_STATE_TEXT[kind.state] ?? '主人在用电脑';
  try {
    const { said, imageBytes } = await lookAndTalk(
      ctx,
      DEFAULT_PET,
      `${where}（前台窗口「${title}」）。这是没人追问时你自己看一眼，简短一两句就行。`,
    );
    saveEye({
      lastEyeAt: Date.now(),
      lastSaid: said,
      lastSkip: '',
      lastError: '',
      lastState: kind.state,
      fired: eyeState().fired + 1,
    });
    if (runtime) runtime.lastEye = `瞄了一眼「${title}」（${Math.round(imageBytes / 1024)}KB）→ ${said.slice(0, 40)}`;
    return true;
  } catch (err) {
    const message = String(err?.message ?? err);
    // 失败也把 lastEyeAt 推到现在：按「推不了就不推」不重试
    saveEye({ lastEyeAt: Date.now(), lastError: message });
    if (runtime) runtime.lastEye = `瞄一眼失败：${message.slice(0, 60)}`;
    return false;
  }
}

/** 主人点名要看：跳过时间闸门，但仍避开会议/网课。 */
async function eyeLookNow(ctx, hint = '', petId = DEFAULT_PET) {
  const probe = await probeDesktop().catch(() => null);
  const title = probe ? String(probe.foreground.title).replace(/\s+/g, ' ').trim().slice(0, 50) : '';
  if (probe) {
    const kind = classifyDesktop(probe);
    if (kind.state === 'meeting') throw new Error(`pet-link: ${kind.reason}，这次不截屏`);
  }
  const extra = [title ? `主人正在用「${title}」` : '', hint].filter(Boolean).join('，');
  const { said, imageBytes } = await lookAndTalk(ctx, petId, extra);
  saveEye({ lastEyeAt: Date.now(), lastSaid: said, lastSkip: '', lastError: '', fired: eyeState().fired + 1 });
  return { said, imageBytes };
}

// ── 反向通道：菜单 → 会话 ───────────────────────────────────────────────────

/** 把一条文本投进最近活动的会话，等于替用户敲了一句话。 */
function pickTargetSession(sc, signal) {
  return sc.list({}, signal).then((listed) => {
    const items = Array.isArray(listed?.items) ? listed.items : [];
    const target = items.find((item) => item && typeof item.sessionId === 'string' && item.sessionId);
    if (!target) throw new Error('pet-link: 没有可投递的会话');
    return target.sessionId;
  });
}

async function wakeAgent(ctx, text) {
  const sc = ctx.get('sessionController');
  if (!sc) throw new Error('pet-link: sessionController 服务不可用');
  if (typeof sc.list !== 'function' || typeof sc.prompt !== 'function') {
    throw new Error('pet-link: sessionController 上没有 list/prompt');
  }
  const signal = AbortSignal.timeout(15_000);
  const sessionId = await pickTargetSession(sc, signal);
  await sc.prompt({ sessionId, content: [{ type: 'text', text }], requestId: randomUUID() }, signal);
  return sessionId;
}

/**
 * 目标会话正忙（这一轮还没跑完 / 输入框里压着排队消息）时先别投。
 * 硬投会塞进输入队列，界面上看着像主人自己打了一句没发出去的话。
 */
async function targetSessionBusy(ctx) {
  const sc = ctx.get('sessionController');
  if (!sc || typeof sc.list !== 'function' || typeof sc.state !== 'function') return false;
  const signal = AbortSignal.timeout(15_000);
  const sessionId = await pickTargetSession(sc, signal);
  const state = await sc.state({ sessionId }, signal);
  const queued = Array.isArray(state?.queue) ? state.queue.length : 0;
  return Boolean(state && (state.running || queued > 0));
}

/** 后台循环：注册菜单 → 长轮询点击 → 投会话。失败退避重试，宠物晚启动也能接上。 */
function startPetMenuLoop(ctx) {
  const runtime = { registered: false, lastEvent: '', lastError: '', clicks: 0, lastTrio: '', lastEye: '' };
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
          const until = Date.now() + 2 * 3600_000;
          saveHealth({ mutedUntil: until, nextAt: nextSlot(until) });
          // 「静音 2 小时」连眼睛一起停：不能嘴上安静、背地里还在截屏
          saveEye({ mutedUntil: until });
          note = `静音 2 小时：提醒和眼睛都停（到 ${new Date(until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）`;
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
    if (label === MENU_DELIVER) {
      try {
        const { messages } = readChatMessages(petId);
        const last = [...messages]
          .reverse()
          .find((m) => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
        if (!last) throw new Error('它还没说过话');
        const said = last.content.replace(WAKE_MARK_RE, '').replace(/\s+/g, ' ').trim().slice(0, 900);
        syncTrioCursor(petId);
        const sessionId = await wakeAgent(ctx, `〔大肥鱼〕${said}`);
        runtime.lastEvent = `${stamp} ${label}（${petId}）→ 已投递 …${sessionId.slice(-8)}`;
        runtime.lastError = '';
      } catch (err) {
        runtime.lastEvent = `${stamp} ${label}（${petId}）→ 失败`;
        runtime.lastError = String(err?.message ?? err);
      }
      return;
    }
    const text = MENU_TEXT[label] ?? `〔大肥鱼〕小鲸，主人点了「${label}」。（这是主人在我右键菜单上点的。）`;
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
        // 每轮（约 9 秒）顺带问一次健康节奏该不该吱声
        await tickHealth(ctx).catch(() => {});
        // 顺带看一眼大肥鱼有没有新说的话（三人行的反向通道）
        await pollTrio(ctx, runtime).catch(() => {});
        // 眼睛：到点、非会议/视频才瞄一眼（多数轮次在这里一行就返回）
        await eyeTick(ctx, runtime).catch(() => {});
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
        // 长轮询能正常返回，说明这条通道此刻是通的：把上一次的错误清掉，
        // 免得一次历史超时永远挂在 pet_link_info 上冒充当前故障。
        runtime.lastError = '';
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

// ── 事件通知：宿主事件 → 大肥鱼的气泡 ────────────────────────────────────────
//
// 只弹气泡：走 /broadcast（surface=any），不经过它的模型、不写它的记忆、不花额度。
// 事件源与 dsh-pet 自己的通知同源：session/event 的 approval/asked、turn/end、
// ask_user_question 的 tool/call，以及 agent/error。子代理/委派会话一律不提醒——
// 你等的是主对话，不是某一路子代理跑完。

const NOTIFY_TEXT_MAX = 140;
/** 两条气泡之间至少隔 4 秒，避免一波事件把屏幕刷满。 */
const NOTIFY_GAP_MS = 4_000;
/** 同一句话 60 秒内不重复弹。 */
const NOTIFY_REPEAT_MS = 60_000;

const notifyRuntime = { sent: 0, lastText: '', lastAt: 0, lastError: '' };

function notifyEnabled() {
  const state = loadState();
  return state.notify?.enabled !== false;
}

function setNotifyEnabled(enabled) {
  updateState((state) => {
    state.notify = { ...(state.notify ?? {}), enabled };
  });
}

function clipNotify(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > NOTIFY_TEXT_MAX ? `${flat.slice(0, NOTIFY_TEXT_MAX - 1)}…` : flat;
}

function isSubagentSession(session) {
  const header = session?.header;
  if (!header || typeof header !== 'object') return false;
  if (header.origin === 'subagent') return true;
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0;
}

/** 弹一条气泡；失败只记 lastError，绝不把事件监听搞崩。force=true 绕过开关（只给 test 用）。 */
async function pushBubble(ctx, text, { force = false } = {}) {
  if (!force && !notifyEnabled()) return false;
  const now = Date.now();
  if (now - notifyRuntime.lastAt < NOTIFY_GAP_MS) return false;
  if (text === notifyRuntime.lastText && now - notifyRuntime.lastAt < NOTIFY_REPEAT_MS) return false;
  try {
    await callPet(ctx, {
      method: 'POST',
      path: '/broadcast',
      query: { pet: DEFAULT_PET, surface: 'any' },
      body: { text: clipNotify(text), duration: 9_000 },
      timeoutMs: 5_000,
    });
    notifyRuntime.sent += 1;
    notifyRuntime.lastText = text;
    notifyRuntime.lastAt = now;
    notifyRuntime.lastError = '';
    return true;
  } catch (err) {
    notifyRuntime.lastError = String(err?.message ?? err);
    return false;
  }
}

function notifyTextOf(event) {
  const type = event?.type;
  const data = event?.data ?? {};
  if (type === 'approval/asked') {
    const tool = String(data.toolName ?? data.tool ?? data.name ?? '').trim();
    const reason = String(data.reason ?? '').trim();
    return `⚠️ 有个权限确认要点一下${tool ? `：${tool}` : ''}${reason ? `（${reason}）` : ''}`;
  }
  if (type === 'tool/call' && String(data.name ?? '') === 'ask_user_question') {
    return '❓ 我在等你回答一个问题';
  }
  if (type === 'turn/end') {
    const kind = data.reason?.kind;
    if (kind === 'completed') return '✅ 这一轮跑完啦';
    if (kind === 'error') {
      const message = String(data.reason?.error?.message ?? '').trim();
      return `❌ 这一轮出错了${message ? `：${message}` : ''}`;
    }
    if (kind === 'max-tokens') return '⚠️ 输出被截断了';
    return null;
  }
  return null;
}

/** 挂上事件监听；ctx.effect 卸载时会替我们调返回的清理函数。 */
function installNotifyWatcher(ctx) {
  return ctx.effect(() => {
    const offSession = ctx.on('session/event', (session, event) => {
      if (isSubagentSession(session)) return;
      const text = notifyTextOf(event);
      if (text) void pushBubble(ctx, text);
    });
    const offError = ctx.on('agent/error', (payload) => {
      const message = String(payload?.error?.message ?? '').trim();
      void pushBubble(ctx, `❌ 生成失败${message ? `：${message}` : ''}`);
    });
    return () => {
      try {
        offSession?.();
      } catch {
        /* 卸载阶段的失败不该再抛 */
      }
      try {
        offError?.();
      } catch {
        /* ignore */
      }
    };
  }, 'pet-link: 事件通知');
}

export function apply(ctx) {
  migrateState();
  const runtime = startPetMenuLoop(ctx);
  installNotifyWatcher(ctx);

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
      syncTrioCursor(pet);
      return {
        ok: true,
        pet,
        reply,
        image: typeof data?.image === 'string' ? data.image : '',
        action: typeof data?.action === 'string' ? data.action : '',
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

  // ── pet_inbox：翻大肥鱼那边的聊天记录 ──────────────────────────────────
  ctx.tools.register({
    name: 'pet_inbox',
    description:
      '翻大肥鱼那边的聊天记录（它说的和主人对它说的都在 memory.json 里），不用等它主动叫你。默认返回自上次读过以后的新消息；markRead=true 顺手记已读。action=read 读，action=mark 只记已读到最新。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read', 'mark'], description: '默认 read。' },
        limit: { type: 'integer', description: '最多返回多少条，默认 20，上限 100。' },
        sinceTs: { type: 'integer', description: '只要 ts 大于这个毫秒时间戳的消息；给了就忽略已读游标。' },
        pet: { type: 'string', description: '桌宠 id，默认 main。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          file: { type: 'string' },
          total: { type: 'integer' },
          unread: { type: 'integer' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string' },
                text: { type: 'string' },
                ts: { type: 'integer' },
              },
              required: ['role', 'text', 'ts'],
            },
          },
        },
        required: ['ok', 'file', 'total', 'unread', 'messages'],
      },
      render: (_a, v) => {
        const lines = [`大肥鱼的对话：共 ${v.total} 条，未读 ${v.unread} 条`];
        for (const m of v.messages) {
          const when = m.ts ? new Date(m.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
          lines.push(`${m.role === 'assistant' ? '大肥鱼' : '主人'}（${when}）：${m.text}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = String(args.action ?? 'read');
      if (!['read', 'mark'].includes(action)) throw new Error('pet_inbox: action 只能是 read / mark');
      const pet = petIdOf(args.pet);
      let limit = 20;
      if (args.limit !== undefined) {
        limit = Number(args.limit);
        if (!Number.isFinite(limit) || limit < 1 || limit > 100) throw new Error('pet_inbox: limit 必须是 1–100');
      }
      const { file, messages } = readChatMessages(pet);
      const trio = trioState();
      const lastTs = Number.isFinite(args.sinceTs) ? Number(args.sinceTs) : trio.lastReadTs;
      const rows = messages
        .filter((m) => m && typeof m.content === 'string' && Number(m.ts ?? 0) > lastTs)
        .map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          text: String(m.content).slice(0, 1200),
          ts: Number(m.ts ?? 0),
        }));
      const unread = rows.length;
      if (action === 'mark' && messages.length) {
        const newest = messages[messages.length - 1];
        saveTrio({ lastReadTs: Number(newest?.ts ?? Date.now()) });
      }
      const shown = rows.slice(-limit);
      if (action === 'read' && shown.length) {
        saveTrio({ lastReadTs: Math.max(trio.lastReadTs, shown[shown.length - 1].ts) });
      }
      return { ok: true, file, total: messages.length, unread, messages: shown };
    },
  });

  // ── pet_trio：三人行模式 ────────────────────────────────────────────────
  ctx.tools.register({
    name: 'pet_trio',
    description:
      '配置「三人行」：大肥鱼说的话怎样传到我这里。smart=它写【叫小鲸】时才把我叫醒（默认，省 token）；all=它每说一句都叫醒我（90 秒合并一次，会费生成额度）；off=都不叫，只记在 pet_inbox 里。status 看现状。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'smart', 'all', 'off'],
          description: '默认 status。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          enabled: { type: 'boolean' },
          cursorCount: { type: 'integer' },
          total: { type: 'integer' },
          woken: { type: 'integer' },
          lastWakeText: { type: 'string' },
          lastError: { type: 'string' },
          memoryFile: { type: 'string' },
        },
        required: ['ok', 'mode', 'enabled', 'cursorCount', 'total', 'woken', 'lastWakeText', 'lastError', 'memoryFile'],
      },
      render: (_a, v) => [
        {
          type: 'text',
          text: [
            `三人行：${v.mode}${v.enabled ? '' : '（已停用）'}｜已累计叫醒 ${v.woken} 次`,
            `记忆文件：${v.memoryFile}（共 ${v.total} 条，游标 ${v.cursorCount}）`,
            v.lastWakeText ? `最近叫醒内容：${v.lastWakeText}` : '',
            v.lastError ? `最近错误：${v.lastError}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = String(args.action ?? 'status');
      if (!['status', 'smart', 'all', 'off'].includes(action)) {
        throw new Error('pet_trio: action 只能是 status / smart / all / off');
      }
      if (action !== 'status') saveTrio({ mode: action, enabled: action !== 'off' });
      const trio = trioState();
      const { file, messages } = readChatMessages(DEFAULT_PET);
      return {
        ok: true,
        mode: trio.mode,
        enabled: trio.enabled,
        cursorCount: trio.cursorCount,
        total: messages.length,
        woken: trio.woken,
        lastWakeText: trio.lastWakeText,
        lastError: trio.lastError,
        memoryFile: file,
      };
    },
  });

  // ── pet_health：健康节奏 ────────────────────────────────────────────────
  ctx.tools.register({
    name: 'pet_health',
    description:
      '管理大肥鱼自己的健康提醒：固定钟点制，每小时 :00 和 :40 各弹一句（夜里也不停），按段落换内容——00–08 半夜池（催睡+关心）、08–20 白天池（休息+活动）、20–24 夜间池（收工+关系）。最近 3 小时没有会话活动就不打扰，推到下一个钟点。action=status 看下一次、test 立刻试一条（不扰动真节奏）、on/off 开关（on 会顺带解除静音）、mute 静音 2 小时。它只弹气泡，不花生成额度。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'test', 'on', 'off', 'mute'], description: '默认 status。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          enabled: { type: 'boolean' },
          nextAtText: { type: 'string' },
          intervalMinutes: { type: 'integer' },
          segmentText: { type: 'string' },
          gridText: { type: 'string' },
          mutedUntilText: { type: 'string' },
          said: { type: 'string' },
        },
        required: ['ok', 'enabled', 'nextAtText', 'intervalMinutes', 'segmentText', 'gridText', 'mutedUntilText', 'said'],
      },
      render: textRenderer((v) => {
        const bits = [
          `健康提醒：${v.enabled ? '开' : '关'}`,
          `下一次 ${v.nextAtText}`,
          `钟点 ${v.gridText}（${v.segmentText}）`,
          `距下一次 ${v.intervalMinutes} 分钟`,
        ];
        if (v.mutedUntilText) bits.push(`静音到 ${v.mutedUntilText}`);
        if (v.said) bits.push(`刚说：「${v.said}」`);
        return bits.join('；');
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = String(args.action ?? 'status');
      const fmt = (ms) =>
        ms
          ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          : '';
      let said = '';
      if (action === 'on') {
        // on 就是要恢复打扰：顺手解掉静音，下一次交给后台循环重新排
        saveHealth({ enabled: true, mutedUntil: 0, nextAt: 0 });
      } else if (action === 'off') {
        saveHealth({ enabled: false });
      } else if (action === 'mute') {
        const until = Date.now() + 2 * 3600_000;
        saveHealth({ mutedUntil: until, nextAt: nextSlot(until) });
      } else if (action === 'test') {
        said = (await tickHealth(ctx, { force: true, ephemeral: true })) ?? '';
        if (!said) throw new Error('pet_health: 没弹出去（可能关着、静音中，或它睡着了）');
      }
      const health = healthState();
      return {
        ok: true,
        enabled: health.enabled,
        nextAtText: fmt(health.nextAt) || '（还没排）',
        intervalMinutes: Math.max(0, Math.round(((health.nextAt || nextSlot(Date.now())) - Date.now()) / 60_000)),
        segmentText: segmentLabel(Date.now()),
        gridText: GRID_TEXT,
        mutedUntilText: health.mutedUntil > Date.now() ? fmt(health.mutedUntil) : '',
        said,
      };
    },
  });

  // ── pet_eye：它自己的眼睛 ───────────────────────────────────────────────
  ctx.tools.register({
    name: 'pet_eye',
    description:
      '管大肥鱼自己的「眼睛」：宿主后台按间隔（默认 15 分钟，可调 10–30）替它瞄一眼屏幕，随时可看，不再等主人停手——只留一个例外：主人在开会/上网课/看视频时不看不吭声；学习/工作间隔翻倍（最多 30 分钟），打游戏按正常节奏；看完由它自己随意说一两句，不推进会话。右键菜单的「静音 2 小时」会连它一起停。action=status 看状态与上次结果；now/test 立刻看一次（跳过时间闸门，仍避开会议）；on/off 开关（on 解除静音）；interval 改间隔（要给 minutes，10–30）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'now', 'test', 'on', 'off', 'interval'],
          description: '默认 status。',
        },
        minutes: { type: 'integer', minimum: 10, maximum: 30, description: '仅 interval 用：间隔分钟数（10–30）。' },
        hint: { type: 'string', description: '仅 now/test 用：要它重点看什么（不超过 120 字）。' },
        pet: { type: 'string', description: '桌宠 id，默认 main。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          enabled: { type: 'boolean' },
          intervalMinutes: { type: 'integer' },
          nextAtText: { type: 'string' },
          fired: { type: 'integer' },
          lastSaid: { type: 'string' },
          lastSkip: { type: 'string' },
          lastError: { type: 'string' },
          lastState: { type: 'string' },
          mutedUntilText: { type: 'string' },
          said: { type: 'string' },
        },
        required: [
          'ok',
          'enabled',
          'intervalMinutes',
          'nextAtText',
          'fired',
          'lastSaid',
          'lastSkip',
          'lastError',
          'lastState',
          'mutedUntilText',
          'said',
        ],
      },
      render: textRenderer((v) =>
        [
          `眼睛：${v.enabled ? '开' : '关'}｜每 ${v.intervalMinutes} 分钟（学习/工作翻倍，封顶 30）｜下一次 ${v.nextAtText}｜累计 ${v.fired} 次`,
          v.mutedUntilText ? `静音到 ${v.mutedUntilText}` : '',
          v.lastSaid ? `上次看到：「${v.lastSaid}」` : '',
          v.lastSkip ? `上次跳过：${v.lastSkip}` : '',
          v.lastError ? `上次错误：${v.lastError}` : '',
          v.said ? `刚看：${v.said}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = String(args.action ?? 'status');
      const fmt = (ms) =>
        ms
          ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          : '';
      let said = '';
      if (action === 'on') {
        saveEye({ enabled: true, lastCheckAt: 0, mutedUntil: 0 });
      } else if (action === 'off') {
        saveEye({ enabled: false });
      } else if (action === 'interval') {
        const minutes = Number(args.minutes);
        if (!Number.isFinite(minutes)) throw new Error('pet_eye: 改间隔要给 minutes（10–30）');
        saveEye({
          intervalMinutes: Math.min(EYE_MAX_INTERVAL_MIN, Math.max(EYE_MIN_INTERVAL_MIN, Math.round(minutes))),
          lastCheckAt: 0,
        });
      } else if (action === 'now' || action === 'test') {
        const hint = String(args.hint ?? '').slice(0, 120);
        const { said: own } = await eyeLookNow(ctx, hint, petIdOf(args.pet));
        said = own;
        if (!said) throw new Error('pet_eye: 看了，但它没说话');
      }
      const eye = eyeState();
      const muted = eye.mutedUntil > Date.now();
      const nextAt = eye.enabled && !muted ? Math.max(eye.lastEyeAt, eye.lastCheckAt) + eyeIntervalMs(eye, eye.lastState) : 0;
      return {
        ok: true,
        enabled: eye.enabled,
        intervalMinutes: eye.intervalMinutes,
        nextAtText: nextAt ? fmt(nextAt) : muted ? '（静音中）' : '（关着）',
        fired: eye.fired,
        lastSaid: eye.lastSaid,
        lastSkip: eye.lastSkip,
        lastError: eye.lastError,
        lastState: eye.lastState,
        mutedUntilText: muted ? fmt(eye.mutedUntil) : '',
        said,
      };
    },
  });

  // ── pet_notify：事件提醒开关 ─────────────────────────────────────────────
  ctx.tools.register({
    name: 'pet_notify',
    description:
      '管理「宿主事件 → 大肥鱼气泡」的提醒：我这一轮跑完、出错、输出被截断、有权限确认、或在等你回答问题时，它会弹一条气泡（只弹气泡，不花生成额度）。action=status 看开关与统计，on / off 切换，test 立刻弹一条验证通路。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'on', 'off', 'test'],
          description: '默认 status。on/off 只改开关；test 绕过开关直接弹一条。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          enabled: { type: 'boolean' },
          sent: { type: 'integer' },
          lastText: { type: 'string' },
          lastError: { type: 'string' },
          said: { type: 'string' },
        },
        required: ['ok', 'enabled', 'sent', 'lastText', 'lastError', 'said'],
      },
      render: textRenderer((v) =>
        [
          `事件提醒：${v.enabled ? '开' : '关'}｜本次启动已弹 ${v.sent} 条`,
          v.lastText ? `最近一条：${v.lastText}` : '',
          v.lastError ? `最近错误：${v.lastError}` : '',
          v.said ? `刚弹：${v.said}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = String(args.action ?? 'status');
      if (!['status', 'on', 'off', 'test'].includes(action)) {
        throw new Error('pet_notify: action 只能是 status / on / off / test');
      }
      let said = '';
      if (action === 'on') setNotifyEnabled(true);
      else if (action === 'off') setNotifyEnabled(false);
      else if (action === 'test') {
        const text = '🔔 通知测试：以后我跑完一轮、出错或等你点确认时，就这么提醒你。';
        const ok = await pushBubble(ctx, text, { force: true });
        if (!ok) throw new Error('pet_notify: 没弹出去（可能它睡着了，或 webServer 拿不到端口）');
        said = text;
      }
      return {
        ok: true,
        enabled: notifyEnabled(),
        sent: notifyRuntime.sent,
        lastText: notifyRuntime.lastText,
        lastError: notifyRuntime.lastError,
        said,
      };
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
          version: { type: 'string' },
          origin: { type: 'string' },
          menuRegistered: { type: 'boolean' },
          menuLabels: { type: 'array', items: { type: 'string' } },
          clicks: { type: 'integer' },
          lastEvent: { type: 'string' },
          lastError: { type: 'string' },
          sessions: { type: 'array', items: { type: 'string' } },
          stateFile: { type: 'string' },
        },
        required: ['ok', 'version', 'origin', 'menuRegistered', 'menuLabels', 'clicks', 'lastEvent', 'lastError', 'sessions', 'stateFile'],
      },
      render: (_a, v) => {
        const lines = [
          `版本：${v.version || '未知'}｜端口：${v.origin || '（拿不到 webServer）'}`,
          `菜单：${v.menuRegistered ? '已注册' : '未注册'}（${v.menuLabels.join(' / ')}）`,
          `点击：${v.clicks} 次；最近：${v.lastEvent || '（无）'}`,
        ];
        if (v.lastError) lines.push(`最近错误：${v.lastError}`);
        lines.push(`会话：${v.sessions.length ? v.sessions.join('、') : '（没有可投递的会话）'}`);
        const health = healthState();
        const hhmm = (ms) =>
          ms ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未排';
        lines.push(
          `健康提醒：${health.enabled ? '开' : '关'}${health.mutedUntil > Date.now() ? '（静音中）' : ''}，下一次 ${hhmm(health.nextAt)}；钟点 ${GRID_TEXT}（${segmentLabel(Date.now())}）`,
        );
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
        version: pluginVersion(),
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
