# dsh-pet-link

把桌宠 **dsh-pet**（大肥鱼）桥接成 agent 工具，并给它一条能反过来叫你的通道。

v0.1 只有单向：我借它的嘴说话、和它对话。
v0.2 补上反向：你在桌宠上右键点一下，这一头的我就被叫起来了。
v0.3 让它自己动手：瞄一眼屏幕、催你歇会儿，这两下不惊动会话也不花生成额度。
v0.5 收窄工具面：去掉待办板和定时提醒（dsh-pet 自己的待办与提醒已经够用，两套并起来只会打架），
     顺手修了「静音之后 on 解不回来」「长轮询成功后旧错误永久残留」两个小毛病。
v0.6 补上事件通知：我跑完一轮、出错、等你点确认、或者有问题等你回答时，它会弹一句气泡；
     只走 `/broadcast`，不经过它的模型、不花生成额度。

不 fork dsh-pet、不 import 它，只走它公开的 HTTP 契约（`/dsh-pet-7340`），
所以 dsh-pet 升级不会把这里带崩。

## 工具

| 工具 | 做什么 |
| --- | --- |
| `pet_say` | 借它的嘴弹一句气泡（不过它的模型、不写记忆） |
| `pet_chat` | 和它真聊一句（人设 + 记忆 + 模型，写进它的 memory.json） |
| `pet_state` | 它此刻在睡、在说、在做什么 |
| `pet_watch` | 一起看片：打开链接 + 它应一声 + 记下在看什么 |
| `pet_look` | 瞄一眼屏幕：截屏压成 JPEG 发给它的模型，它用气泡说出看到什么 |
| `pet_health` | 健康节奏：看表提醒喝水/起身/远眺；`on` 会顺带解除静音，`test` 试一句但不扰动真节奏 |
| `pet_ring` | 手动叫一次我（验证反向通道） |
| `pet_notify` | 管理「宿主事件 → 气泡」：`status` 看开关与统计，`on`/`off` 切换，`test` 立刻弹一条 |
| `pet_link_info` | 排障：端口、菜单注册、会话、最近点击与错误 |

## 反向通道怎么走

1. 插件在 `apply()` 里向 dsh-pet 注册 owner=`pet-link` 的右键菜单：
   `小鲸，来一下` / `一起看会儿视频` / `瞄一眼我这边` / `提醒我歇会儿` / `静音 2 小时`。
2. 后台长轮询 `GET /menu/events?owner=pet-link&wait=9000`（读取即消费，最长挂 10 秒）。
3. 前两项投给会话：用宿主的 `sessionController.list()` 找最近活动的会话，
   再 `sessionController.prompt({ sessionId, content: [{type:'text',text}], requestId })`
   投一条以 `〔大肥鱼〕` 开头的消息进去。
4. 后三项插件自己办：`瞄一眼我这边` 直接截图 + `/chat` 带图片让它自己说；
   `提醒我歇会儿` 立刻弹一句催你起来（v0.5 起不再挂定时器）；`静音 2 小时` 把健康节奏按下去。

投递会走「用户消息」通道——所以那条消息看起来像用户发的，前缀是唯一的分辨标记。
它投进的是**最近活动的会话**，不一定是你看的这个；想指定就先把目标会话切到最前。

菜单注册表是 dsh-pet 的进程内存态，DSH 或桌宠重启后要重新注册；
插件会自己发现 `unknown-owner` 并重新注册，不用手动干预。

## 事件通知（v0.6）

- 挂在宿主事件上，不改 dsh-pet：`session/event` 与 `agent/error`，在 `ctx.effect()` 里注册，卸载自动清理。
- 会弹的四种：权限确认/审批（`approval`、`asked`）、`ask_user_question`（我在等你回答）、
  `turn/end` 的 `completed` / `error` / `max-tokens`、以及 `agent/error`。
  中断、取消、阻塞这类不弹，免得刷屏。
- 子代理会话（`header.origin === 'subagent'` 或 `delegationDepth > 0`）不提醒，只报主会话。
- 只调 `POST /broadcast?pet=main&surface=any` 弹气泡：4 秒节流、60 秒内同一句去重、最长 140 字。
  不经过它的模型，也不写它的对话记忆。
- 开关在 `state.json` 的 `notify.enabled`（默认开）；`pet_notify status` 能看已弹条数和最近一次错误。
- `surface=any` 表示 web 端和桌面端都发；它睡着或被别的会话锁住时发不出去，只记错误、不重试。

## 瞄一眼屏幕

- 截图用 `capture.py`（Pillow 的 `ImageGrab.grab(all_screens=True)`），先缩到宽 1280、JPEG q72，
  超 900k base64 就退到 960/q55。解释器按 `DSH_PYTHON` → `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe`
  → PATH 里的 `python` 顺序找，要求带 Pillow。
- **不用 PowerShell**：`CopyFromScreen` + `Bitmap.Save` 这类脚本会被 AMSI 判成恶意内容直接拦掉
  （报 `ScriptContainedMaliciousContent`），换 python 才过得去。
- 图会作为 `attachment` 发给它自己的模型（`POST /chat`，白名单 `image/png|jpeg|webp|gif`），
  所以这是「把屏幕给模型看」——隐私成本要心里有数。它只能看懂大意，不会点击、不落盘。

## 健康节奏

它自己看表，不用你设置。规则写在 `healthInterval()` / `healthPool()` 里：

| 时段 | 间隔 | 说什么 |
| --- | --- | --- |
| 9:00–12:00 / 13:00–18:00 / 19:00–22:00 | 50 分钟 | 喝水、起身、远眺、伸懒腰、眨眼、转脖子（轮换） |
| 12:00–13:00 / 18:00–19:00 | 90 分钟 | 同上，饭点少打扰 |
| 22:00–24:00 | 30 分钟 | 收工、睡觉 |
| 0:00–9:00 | 不提醒 | 下一次排到当天 9:00 |

- 三小时没跟 DSH 打过交道就当作人不在，这一条推迟 10 分钟再看，不往空屋子里说话。
- 状态在 `state.json` 的 `health` 里：`enabled` / `nextAt` / `index`（说到第几句）/ `mutedUntil`。
- 它睡着或被锁住时发不出去，5 分钟后重试，不占序号。
- 右键菜单「静音 2 小时」临时按下；`pet_health` 工具可以 `on` / `off` / `mute` / `test`
  （`on` 会顺带解掉静音，`test` 只弹一句、不动下一次的时间）。

## 注意

- `pet_watch` 的 `open=true` 会用系统默认浏览器打开链接（用户事先同意过为看资料/刷 B 站打开）。
- 状态文件在 profile 目录，跟着备份一起走。
- `pet_notify` 报的是「我」的状态（跑完一轮/出错/等你点确认/等你回答），不是它的健康提醒；健康那套归 `pet_health`。

## 安装 / 升级

现状（0.6.x）：这个包的 cordis 条目是 `include:pet-link`、`readOnlyReason="unaddressable"`，
`remove_bundle` 会报 `bundle-in-use`、`install_bundle` 会报 `already-installed`。**别用 remove**——
它虽然报失败，却会把 `dsh-pet-link` 从 profile 的 `dsh.profile.bundles` 里摘掉，重启后插件整个消失
（补回来：`plugin_manager set_bundle dsh-pet-link enabled=true`）。

实际升级步骤：

1. 改 `D:\DSH_DATA\plugins\dsh-pet-link` 里的源码，并把 `package.json` 的 `version` 升上去；
2. 直接覆盖 profile 里的副本（那是真实目录，不是软链）：
   `cp index.js package.json README.md "C:\Users\jiaba\.dsh\profiles\desktop\node_modules\dsh-pet-link\"`；
3. 重启 DSH。

`capture.py` 必须留在包里（`package.json` 的 `files` 里有），否则 `pet_look` 会报「插件包不完整」。

## 排障

先调 `pet_link_info`。它会给端口、菜单是否注册、可选会话、最近一次点击投到了哪（sessionId 后 8 位）和最近错误。
气泡没弹就再调 `pet_notify status`：看开关是否开着、已弹几条、`lastError` 里是不是「睡着/被锁」或 HTTP 错误。
