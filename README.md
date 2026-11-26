# dsh-pet-link

把桌宠 dsh-pet（大肥鱼）桥接成 agent 工具，并给它一条能反过来叫你的通道。

- v0.1 只有单向：我借它的嘴说话、和它对话。
- v0.2 补上反向：你在桌宠上右键点一下，这一头的我就被叫起来了。
- v0.3 让它自己动手：瞄一眼屏幕、催你歇会儿，这两下不惊动会话也不花生成额度。
- v0.5 收窄工具面：去掉待办板和定时提醒（dsh-pet 自己的待办与提醒已经够用，两套并起来只会打架），顺手修了「静音之后 on 解不回来」「长轮询成功后旧错误永久残留」两个小毛病。
- v0.6 补上事件通知：我跑完一轮、出错、等你点确认、或者有问题等你回答时，它会弹一句气泡；只走 `/broadcast`，不经过它的模型、不花生成额度。
- v0.7 健康提醒改钟点制：每小时 :00 和 :40 各一次、全天不停，半夜/白天/夜间三段各说各的话；右键菜单去掉「提醒我歇会儿」——提醒归插件自动做，不再需要手动催。
- v0.8 支持「三人行」：轮询大肥鱼的对话记忆，它写【叫小鲸】时自动把话投到最近会话；新增 `pet_inbox` 翻全部聊天、`pet_trio` 调投递策略。
- v0.9 多一只「眼睛」：后台按间隔自己瞄一眼屏幕，看完由它自己说两句，不推进会话。
- v0.9.2 眼睛定型：间隔 10–30 分钟（默认 15），随时可看、不再等主人停手（v0.9.0 的两分钟空闲闸门和全屏判断已删）；只留一个例外——开会/上网课/看视频时不看不吭声，学习工作翻倍、封顶 30，打游戏正常。

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
| `pet_eye` | 管它自己的「眼睛」：status / now / test / on / off / interval（10–30 分钟） |
| `pet_health` | 健康节奏：钟点制每小时 :00 / :40 一句，按半夜/白天/夜间三段换内容；on 会顺带解除静音，test 试一句但不扰动真节奏 |
| `pet_inbox` | 翻它的聊天记录（它说的和主人对它说的都在 memory.json 里），默认返回自上次读过以后的新消息 |
| `pet_trio` | 配置「三人行」：smart（默认，它写【叫小鲸】才叫醒我）/ all（每句都叫，90 秒合并一次）/ off（都不叫） |
| `pet_ring` | 手动叫一次我（验证反向通道） |
| `pet_notify` | 管理「宿主事件 → 气泡」：status 看开关与统计，on/off 切换，test 立刻弹一条 |
| `pet_link_info` | 排障：端口、菜单注册、会话、最近点击与错误 |

## 反向通道怎么走

插件在 `apply()` 里向 dsh-pet 注册 `owner=pet-link` 的右键菜单：
小鲸，来一下 / 一起看会儿视频 / 瞄一眼我这边 / 静音 2 小时。

后台长轮询 `GET /menu/events?owner=pet-link&wait=9000`（读取即消费，最长挂 10 秒）。
前两项投给会话：用宿主的 `sessionController.list()` 找最近活动的会话，
再 `sessionController.prompt({ sessionId, content: [{type:'text',text}], requestId })`
投一条以 `〔大肥鱼〕` 开头的消息进去。
后两项插件自己办：`瞄一眼我这边` 直接截图 + `/chat` 带图片让它自己说；
`静音 2 小时` 把健康节奏和眼睛一起按下去。

投递会走「用户消息」通道——所以那条消息看起来像用户发的，前缀是唯一的分辨标记。
它投进的是最近活动的会话，不一定是你看的这个；想指定就先把目标会话切到最前。
菜单注册表是 dsh-pet 的进程内存态，DSH 或桌宠重启后要重新注册；
插件会自己发现 unknown-owner 并重新注册，不用手动干预。

## 事件通知（v0.6）

挂在宿主事件上，不改 dsh-pet：`session/event` 与 `agent/error`，在 `ctx.effect()` 里注册，卸载自动清理。
会弹的四种：权限确认/审批（approval、asked）、`ask_user_question`（我在等你回答）、
`turn/end` 的 completed / error / max-tokens、以及 `agent/error`。
中断、取消、阻塞这类不弹，免得刷屏。
子代理会话（`header.origin === 'subagent'` 或 `delegationDepth > 0`）不提醒，只报主会话。
只调 `POST /broadcast?pet=main&surface=any` 弹气泡：4 秒节流、60 秒内同一句去重、最长 140 字。
不经过它的模型，也不写它的对话记忆。
开关在 `state.json` 的 `notify.enabled`（默认开）；`pet_notify status` 能看已弹条数和最近一次错误。
`surface=any` 表示 web 端和桌面端都发；它睡着或被别的会话锁住时发不出去，只记错误、不重试。

## 三人行（v0.8）

`pet_trio` 决定它说的话怎样传到我这里：

- `smart`（默认）：只有它写【叫小鲸】时我才被叫醒，省 token。
- `all`：它每说一句都叫醒我（90 秒合并一次，会费生成额度）。
- `off`：都不叫，只记在 `pet_inbox` 里。

实现是轮询它的 `memory.json` 增量，不碰它的进程。`pet_inbox` 可以随时翻全部聊天记录，
默认只给自上次读过以后的新消息，`markRead=true` 顺手记游标。

## 眼睛（v0.9 → v0.9.2）

宿主后台按间隔替它瞄一眼屏幕，看完由它自己随意说一两句，不推进会话、不花生成额度。

- 间隔 10–30 分钟，默认 15；`pet_eye interval 20` 改。
- **取消**了 v0.9.0 的「两分钟没动键鼠才截图」空闲闸门，也**取消**了全屏判断——随时可看。
- 唯一例外：开会 / 上网课 / 看视频时不看不吭声（`classifyDesktop` 判 `meeting` 或 `video`）。
- 学习/工作间隔翻倍但封顶 30 分钟；打游戏按正常节奏。
- 右键菜单「静音 2 小时」连眼睛一起停；`pet_eye off` 单独关，`pet_eye status` 看上次结果。
- `pet_eye now` / `pet_eye test` 可立刻看一次（test 不扰动真节奏）。

## 瞄一眼屏幕

截图用 `capture.py`（Pillow 的 `ImageGrab.grab(all_screens=True)`），先缩到宽 1280、JPEG q72，
超 900k base64 就退到 960/q55。解释器按 `DSH_PYTHON` → `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe`
→ PATH 里的 `python` 顺序找，要求带 Pillow。
不用 PowerShell：`CopyFromScreen` + `Bitmap.Save` 这类脚本会被 AMSI 判成恶意内容直接拦掉
（报 ScriptContainedMaliciousContent），换 python 才过得去。
图会作为 attachment 发给它自己的模型（`POST /chat`，白名单 image/png|jpeg|webp|gif），
所以这是「把屏幕给模型看」——隐私成本要心里有数。它只能看懂大意，不会点击、不落盘。

## 健康节奏

它自己看表，不用你设置。网格和分段写在 `schedule.js` 里：

| 时段 | 什么时候说 | 说什么 |
| --- | --- | --- |
| 08:00–19:59 白天 | 每小时 :00 和 :40 | 喝水、起身、远眺、伸懒腰、眨眼、转脖子、接水、张开手指、看远楼、深呼吸、勾脚尖、收尾（12 句轮换） |
| 20:00–23:59 夜间 | 每小时 :00 和 :40 | 收工、关灯、别硬撑、别刷手机、明天再说（9 句轮换） |
| 00:00–07:59 半夜 | 每小时 :00 和 :40 | 该睡了、别撑、去洗脸、明天做更快、别拿身体换（5 句轮换） |

全天 24 小时共 48 个钟点（每小时两个），每小时内间隔 40 / 20 分钟交替——这就是「:00 和 :40」。
三小时没跟 DSH 打过交道就当作人不在：这一格不弹，直接推到下一个钟点，不往空屋子里说话。
状态在 `state.json` 的 `health` 里：`enabled` / `nextAt` / `indexByPool`（每段各说到第几句）/ `mutedUntil`。
它睡着或被锁住时发不出去：推到下一个钟点重试，不占序号。
右键菜单「静音 2 小时」临时按下；`pet_health` 工具可以 `on` / `off` / `mute` / `test`
（`on` 会顺带解掉静音，`test` 只弹一句、不动下一次的时间）。

## 注意

- `pet_watch` 的 `open=true` 会用系统默认浏览器打开链接（用户事先同意过为看资料/刷 B 站打开）。
- 状态文件在 profile 目录，跟着备份一起走。
- `pet_notify` 报的是「我」的状态（跑完一轮/出错/等你点确认/等你回答），不是它的健康提醒；健康那套归 `pet_health`，眼睛归 `pet_eye`。
- 眼睛和检查截图会把屏幕画面发给模型，敏感画面请先 `pet_eye off` 或右键静音。

## 安装 / 升级

DSh 版本要求：`>=0.2.0-rc.2 <0.3.0 || 0.2.2-rc.1`，node >= 20.18。

现状（0.9.x）：这个包的 cordis 条目是 `include:pet-link`、`readOnlyReason="unaddressable"`，
`remove_bundle` 会报 bundle-in-use、`install_bundle` 会报 already-installed。别用 remove——
它虽然报失败，却会把 `dsh-pet-link` 从 profile 的 `dsh.profile.bundles` 里摘掉，重启后插件整个消失
（补回来：`plugin_manager set_bundle dsh-pet-link enabled=true`）。

实际升级步骤：

1. 改这个仓库里的源码，并把 `package.json` 的 `version` 升上去；
2. 直接覆盖 profile 里的副本（那是真实目录，不是软链）：
   `cp index.js schedule.js package.json README.md "C:\Users\jiaba\.dsh\profiles\desktop\node_modules\dsh-pet-link\"`；
3. 重启 DSH。

`capture.py` 必须留在包里（`package.json` 的 `files` 里有），否则 `pet_look` 会报「插件包不完整」。

## 排障

先调 `pet_link_info`。它会给端口、菜单是否注册、可选会话、最近一次点击投到了哪（sessionId 后 8 位）和最近错误。
气泡没弹就再调 `pet_notify status`：看开关是否开着、已弹几条、`lastError` 里是不是「睡着/被锁」或 HTTP 错误。
眼睛没动静就调 `pet_eye status`：看是否被静音/关闭、下次什么时候、上次结果是什么。

## License

MIT
