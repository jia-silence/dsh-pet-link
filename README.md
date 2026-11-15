# dsh-pet-link

把桌宠 **dsh-pet**（大肥鱼）桥接成 agent 工具，并给它一条能反过来叫你的通道。

v0.1 只有单向：我借它的嘴说话、和它对话、共享待办板。
v0.2 补上反向：你在桌宠上右键点一下，这一头的我就被叫起来了。
v0.3 让它自己动手：瞄一眼屏幕、到点提醒你，这两下不惊动会话也不花生成额度（后者）。

不 fork dsh-pet、不 import 它，只走它公开的 HTTP 契约（`/dsh-pet-7340`），
所以 dsh-pet 升级不会把这里带崩。

## 工具

| 工具 | 做什么 |
| --- | --- |
| `pet_say` | 借它的嘴弹一句气泡（不过它的模型、不写记忆） |
| `pet_chat` | 和它真聊一句（人设 + 记忆 + 模型，写进它的 memory.json） |
| `pet_todo_add` / `pet_todo_list` | 共享待办板：到点它会弹气泡提醒 |
| `pet_state` | 它此刻在睡、在说、在做什么 |
| `pet_watch` | 一起看片：打开链接 + 它应一声 + 记下在看什么 |
| `pet_look` | 瞄一眼屏幕：截屏压成 JPEG 发给它的模型，它用气泡说出看到什么 |
| `pet_remind` | 稍后提醒：到点弹气泡，不经过模型 |
| `pet_ring` | 手动叫一次我（验证反向通道） |
| `pet_link_info` | 排障：端口、菜单注册、会话、最近点击与错误 |

## 反向通道怎么走

1. 插件在 `apply()` 里向 dsh-pet 注册 owner=`pet-link` 的右键菜单：
   `小鲸，来一下` / `一起看会儿视频` / `瞄一眼我这边` / `提醒我歇会儿`。
2. 后台长轮询 `GET /menu/events?owner=pet-link&wait=9000`（读取即消费，最长挂 10 秒）。
3. 前两项投给会话：用宿主的 `sessionController.list()` 找最近活动的会话，
   再 `sessionController.prompt({ sessionId, content: [{type:'text',text}], requestId })`
   投一条以 `〔大肥鱼〕` 开头的消息进去。
4. 后两项插件自己办：`瞄一眼我这边` 直接截图 + `/chat` 带图片让它自己说；
   `提醒我歇会儿` 往状态文件里挂一条 25 分钟后的提醒。

投递会走「用户消息」通道——所以那条消息看起来像用户发的，前缀是唯一的分辨标记。
它投进的是**最近活动的会话**，不一定是你看的这个；想指定就先把目标会话切到最前。

菜单注册表是 dsh-pet 的进程内存态，DSH 或桌宠重启后要重新注册；
插件会自己发现 `unknown-owner` 并重新注册，不用手动干预。

## 瞄一眼屏幕

- 截图用 `capture.py`（Pillow 的 `ImageGrab.grab(all_screens=True)`），先缩到宽 1280、JPEG q72，
  超 900k base64 就退到 960/q55。解释器按 `DSH_PYTHON` → `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe`
  → PATH 里的 `python` 顺序找，要求带 Pillow。
- **不用 PowerShell**：`CopyFromScreen` + `Bitmap.Save` 这类脚本会被 AMSI 判成恶意内容直接拦掉
  （报 `ScriptContainedMaliciousContent`），换 python 才过得去。
- 图会作为 `attachment` 发给它自己的模型（`POST /chat`，白名单 `image/png|jpeg|webp|gif`），
  所以这是「把屏幕给模型看」——隐私成本要心里有数。它只能看懂大意，不会点击、不落盘。

## 稍后提醒

- 提醒存在 profile 目录的 `dsh-pet-link.state.json` 的 `reminders` 数组里，重启后还在。
- 后台循环每轮（约 9 秒）扫一次：到点的先发气泡，**发成功才从队列删**，宠物睡着也不会丢。
- 走 `/broadcast`，不经过模型，不花生成额度。

## 注意

- `pet_watch` 的 `open=true` 会用系统默认浏览器打开链接（用户事先同意过为看资料/刷 B 站打开）。
- 状态文件在 profile 目录，跟着备份一起走。

## 安装 / 升级

```
plugin_manager: remove_bundle dsh-pet-link
plugin_manager: install_bundle file:D:\\DSH_DATA\\plugins\\dsh-pet-link
```

pnpm 对 `file:` 依赖是**复制**不是链接：改了源码必须升 `version` 再重装，否则跑的是旧副本。
`capture.py` 必须留在包里（`package.json` 的 `files` 里有），否则 `pet_look` 会报「插件包不完整」。

## 排障

先调 `pet_link_info`。它会给端口、菜单是否注册、可选会话、最近一次点击投到了哪（sessionId 后 8 位）和最近错误。
