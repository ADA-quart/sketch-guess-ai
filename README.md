# 你画AI猜 · Windows 本地离线项目

平板作画 → WebSocket 上传笔画 → 本机推理 → 广播到大屏。平板走局域网，大屏与主持页就在运行服务的这台笔记本上（HDMI 扩展屏）直接打开。无云端、无落盘。

> **开源协议：Apache-2.0**（见 [LICENSE](LICENSE)）。可商用、有专利保护；转载请保留版权声明。第三方模型来源与署名见 [NOTICE](NOTICE)——默认基模 CRNN V2 来自 [DucTai368/AI_sketch-recognition-v2](https://huggingface.co/DucTai368/AI_sketch-recognition-v2)（Apache-2.0），降级备份的 DoodleNet 来自 [yining1023/doodleNet](https://github.com/yining1023/doodleNet)。

## 1. 架构

```
安卓平板 /draw              Windows 笔记本 (Node.js)            HDMI 扩展屏 /display
┌────────────────┐       ┌───────────────────────────┐      ┌──────────────────────┐
│ 全屏高分辨率画布 │       │ HTTP + WebSocket 服务       │      │ AI 眼前的画(缩略图)   │
│ 细笔刷 / 防滚动  │ ─────▶│ 单槽帧队列：忙时丢旧帧       │ ────▶│ Top-5 中文+置信度条   │
│ 每400ms 上传笔画 │  ws   │ CRNN V2 序列模型推理(ONNX)   │  ws  │ 置信度走势曲线        │
│ 坐标(非图片!)    │       │ 每 400ms 推理一次            │      │ 猜测翻转 / 锁定特效   │
│ 断线自动重连    │       │ 计时 / 锁定 / 裁定 / 比分     │      │ 裁判环节 / 断连提示   │
└────────────────┘       └──────────┬────────────────┘      └──────────────────────┘
```

- 平板与大屏**都是浏览器页面**，不需要安装 App。大屏是这台笔记本的 HDMI 第二显示器，浏览器直接开在扩展屏上，走 `127.0.0.1`，不经过局域网。
- 大屏只收到 Top-5 类别与置信度，**收不到谜底**，避免画面泄露。
- 主持人在 `/host` 控制开始、锁定、重置、指定谜题，同样在本机打开。

## 2. 当前实际推理路线（重要）

**当前默认路线：CRNN V2 笔画序列模型（服务端 ONNX 推理）**，由 `config.inference.engine: "sequence"` 指定。

| 路线 | engine 值 | 平板上传 | 后端推理 | 模型 |
| --- | --- | --- | --- | --- |
| **序列模型（默认）** | `sequence` | 笔画坐标序列 `[dx,dy,pen]` | `onnxruntime-node` 加载 `model/seq/model.onnx` | CRNN V2，345 类，**~85% top-1** |
| 旧栅格模型（降级备份） | `raster` | 256×256 PNG 图 | 依次试 `tfjs-node` → `onnx` → 平板 TF.js | DoodleNet，345 类，~73% top-1 |

**为什么换成序列模型**：旧 DoodleNet 把整张画布压成 28×28 灰度图，细笔画下采样后被稀释成噪点（要人为加粗才能认）。CRNN V2 直接吃**笔画坐标序列**，不做任何像素下采样——所以你可以铺满整块平板画布、用细笔刷画得好看，AI 照样能认。这是解决"画得细就认不出"的根本办法。

序列模型输入编码（已用官方 QuickDraw 样本实测，简化后命中率 ~79–84%）：
1. **每笔先做 RDP 路径简化**（关键！见下方说明）；
2. 笔画末点标记抬笔 `pen=1`，其余 `pen=0`；
3. 整幅画按包围盒**等比**缩放到 [0,1]；
4. 计算相邻点 delta `[dx,dy]`，配 pen 组成 3 维；
5. 取前 128 点、不足补零，送进 `[1,128,3]` 的输入。

> **为什么必须 RDP 简化**：模型只在 QuickDraw 官方「简化后的稀疏笔画」上训练。平板是高分辨率大画布，`pointermove` 每个事件都采样，一笔就有几百个点——直接喂模型会 **0% 命中**（实测）。先用 Ramer-Douglas-Peucker 算法把密集折线压成稀疏关键点（降到约 30 点），命中率立刻恢复到 79%，且与采样密度无关（1×/5×/10×/20× 都是 79%）。这就是"画得细却认不出"的真正病根与解法。阈值 `inference.simplifyEps`（默认 0.01，相对包围盒比例），越小保留越多细节。

**运行时不需要 Python**：`.keras → ONNX` 的转换是一次性的（脚本 `scripts/convert_seq_onnx.py` 保留备查，在 `doodle-seq` Conda 环境里跑）。项目运行只需要 Node.js + 已装好的 `onnxruntime-node`。

随时确认真实路线：

```
http://127.0.0.1:3000/api/status
```

返回的 `route` 为 `sequence`（序列模型）/ `tfjs-node` / `onnx` / `browser`（后三个是旧栅格路线）；`attempts`、`log` 记录启动细节。要回退到旧栅格模型，把 `config.json` 的 `inference.engine` 改成 `raster` 并重启。

> 注意：中文类别映射按**英文类名**匹配（`categories.zh.json` 的 `byName`），与标签顺序解耦；判分按**索引**比对，所以 `model/seq/labels.json` 的顺序必须与序列模型输出一致。已确认 `labels.json` 的 345 类顺序正确（banana=16 等），中文显示与判分均验证通过。

## 3. 快速开始

```bat
npm install
start.bat
```

模型已随项目放在 `model/seq/model.onnx`（20MB，对战用）和 `model/seq/model-scope.onnx`（20MB，科普页用），**都不需要另外下载，也不需要 Python**——clone 下来开箱即用。只有想重新转换模型时才需要 58MB 的原始 Keras 权重，它未上传仓库，按需从 Hugging Face 下载（见目录一节）。确保 `onnxruntime-node` 已安装（在 `package.json` 的可选依赖里，`npm install` 会装）。旧的 DoodleNet 栅格模型仍在 `model/`，作为降级备份保留。

**你的拓扑：大屏是这台笔记本的 HDMI 扩展屏**，所以：

- 大屏（第二显示器）：`http://127.0.0.1:3000/display`，按 `F11` 全屏
- 主持（笔记本主屏）：`http://127.0.0.1:3000/host`
- 平板：`http://<笔记本局域网IP>:3000/draw`，只有平板需要 IP

`127.0.0.1` 只有笔记本自己能用；**平板上必须用局域网 IP**，平板上的 `localhost` 指的是平板自己。大屏和主持页用 `127.0.0.1` 反而更稳，不受 Wi-Fi 或防火墙影响。

把浏览器窗口移到 HDMI 屏的快捷键：`Win + Shift + →`，然后 `F11`。完整步骤见 [docs/CONNECT.md](docs/CONNECT.md)。

由于 `tfjs-node` / `onnxruntime-node` 是可选依赖，`npm install` 遇到原生模块失败不会阻断整个安装；只是对应路线不可用，会自动降级。安装细节见 [docs/WINDOWS-DEPLOY.md](docs/WINDOWS-DEPLOY.md)。

## 4. 配置

`config/config.json`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `inference.engine` | `sequence` | **推理引擎**：`sequence`=CRNN V2 序列模型（默认，推荐）；`raster`=旧 DoodleNet 栅格模型（降级备份） |
| `round.seconds` | 70 | 单轮时长，自动夹到 60–75 秒 |
| `round.lockThreshold` | 0.72 | Top-1 置信度达到此值且连续稳定 N 帧后锁定 |
| `round.lockStableFrames` | 4 | 锁定所需稳定帧数 |
| `round.lockGraceMs` | 8000 | **作画宽限期**（毫秒）：回合开始后这段时间内绝不锁定，避免画一半的半成品被误锁（如信封只画了方框就被当成枕头）。画得快的人会晚锁，但不错锁。嫌慢可调小 |
| `round.lockMinStrokes` / `lockMinPoints` | 1 / 8 | 锁定所需的最少笔画数/点数，内容太少不锁 |
| 作画状态上报 | — | 平板每帧上报是否正在下笔；**只要还在画就永不锁定**，停笔且过了宽限期、形状稳定后才锁 |
| `inference.intervalMs` | 400 | 平板上传与服务端推理间隔（毫秒） |
| `inference.topK` | 5 | 大屏展示数量 |
| `inference.seqModelPath` | `model/seq/model.onnx` | 序列模型 ONNX 权重路径（sequence 路线用） |
| `inference.seqLabelsPath` | `model/seq/labels.json` | 序列模型 345 类标签顺序（sequence 路线用） |
| `inference.seqLength` | 128 | 序列长度上限（sequence 路线用） |
| `inference.simplifyEps` | 0.01 | **笔画简化阈值**（相对包围盒比例）。把平板密集采样压成 QuickDraw 风格稀疏点；默认 0.01 实测把密集笔画识别率从 0% 恢复到 79%。越小保留越多细节，越大越简化 |
| `round.scoringMode` | fair | `fair`=公平裁定模式（推荐）；`classic`=经典模式（未命中即人类得分） |
| `round.judgeTimeoutMs` | 45000 | 公平模式下等待主持裁定的超时；超时自动判「画得抽象」 |
| `inference.decoyMode` | **false** | 骗AI模式：开启后压制正确答案置信度，制造综艺效果 |
| `tablet.brushRadius` | 2 | 笔刷半径（相对 256 基准画布），默认细笔刷 2 以便画得好看；**序列模型直接读笔画坐标，笔刷粗细不影响识别**。滑块可调 |
| `tablet.brushMin` / `brushMax` | 1 / 8 | 笔刷滑块范围。想画更细可设到 1 |
| `tablet.thumbSize` | 72 | 大屏「AI 眼前的画」缩略图边长 |

> 以下字段只在 `engine: "raster"`（旧栅格路线）生效： `inference.inputSize`(28)、`inference.dilateRadius`(5，下采样前的笔画加粗半径)、`inference.onnxInputLayout`、`tablet.canvasSize`(256)。序列路线不使用它们。

`config/categories.zh.json`：**345 类全量中文映射**，`byName` 按归一化英文名索引（下划线转空格、去 the 前缀），与标签顺序解耦；序列路线的类别顺序由 `model/seq/labels.json` 决定，栅格路线由 `model/labels.txt` 决定。`config/words.json`：60 条词库。`word` 是给选手看的中文题面，`class` 是模型英文类别名，`hint` 是显示在平板上的「AI 友好画法」提示。修改后需重启服务。

> 大屏 Top-5 全部显示中文类别名（345 类已补全），不会再出现英文类别。若更换了别的模型，需同步更新 `labels.txt` 与 `byName`，否则未覆盖的类别会退回显示英文原名。

### 基模来源与「画得像却认不出」

当前基模是 [DucTai368/AI_sketch-recognition-v2](https://huggingface.co/DucTai368/AI_sketch-recognition-v2) 的 **CRNN V2**（Apache-2.0）：Multi-Scale CNN + Multi-Head Attention + Bi-LSTM，同样在 **Google QuickDraw 的 345 类**上训练（约 510 万样本），**top-1 ~85% / top-5 ~95%**。相比旧 DoodleNet（28×28 栅格 CNN，~73%）有两个实质提升：

1. **吃笔画坐标而非 28×28 像素**——铺满画布 + 细笔刷也不糊，不需要任何"膨胀加粗" hack；
2. **识别率高约 12 个百分点**，看笔画顺序、方向与抬笔，对画风差异更鲁棒。

模型已从 `.keras` 转成 ONNX（转换脚本 `scripts/convert_seq_onnx.py`，在 `doodle-seq` Conda 环境里一次性执行）。输入编码经官方样本反推验证（banana 100 样本 84.7% 命中；端到端实测 banana 86.8%）。

**但它仍逃不开 QuickDraw 的画法偏好**：训练数据是真人 20 秒速涂的简笔画，不是写实照片。画得太写实、太抽象、或偏离常见画法仍可能认错。这就是 `words.json` 里 `hint` 的用途——给选手一句「AI 认哪种画法」的提示（如手表要画圆表盘 + 两根表带），减少挫败感。大屏的「AI 眼前的画」实时反馈也能帮选手调整画法。

> **要接受的现实**：再强的 QuickDraw 基模也有识别边界。实测旧模型会把密集的灯泡内部细节看成「胡子」、细长图形看成「仙人掌」；新模型精度更高但仍非万能。遇到个别认不出的词属正常现象，公平裁定模式下由主持人判「画得像→人类得分」即可，不必逐张调参。arXiv 上有基于 CLIP 的"跨抽象层级"草图模型（如 2407.03893）理论上更对症，但体积和算力不适合本机离线部署。

## 5. 交互与结算

### 平板（作画）
- 画布**铺满整个屏幕**（适配 2880×1800 平板），内部按屏幕真实像素作画，默认细笔刷（可按喜好用滑块调 1–8）；触摸已禁用页面滚动与缩放。
- 每 400ms 上传**原始笔画坐标序列**（不是图片！）——序列模型直接读坐标，铺满画布 + 细笔刷都不影响识别。旋转屏幕会保留已有笔画。
- 断连后 0.5→5 秒指数退避自动重连。

> **为什么现在细笔也能认出？** 旧 DoodleNet 把画布压成 28×28，细线缩完只剩淡灰噪点，会被认成"雨"，只能靠膨胀加粗补救。新的 CRNN V2 直接吃笔画坐标 `[dx,dy,pen]`，根本不做像素下采样——你画多细、画布铺多满，信息都完整送进模型。这是换基模最核心的收益。

### 大屏（可视化 AI 的推理过程）
- **「AI 眼前的画」**：实时缩略图，观众能看到 AI 实际接收到的画面。
- **Top-5 中文类别 + 动态置信度条**：榜首变化触发 3D 翻转。
- **置信度走势曲线**：榜首置信度随时间的变化；并显示分析帧数、单帧耗时、当前榜首。
- 锁定后整屏发光并显示"AI 已锁定答案"；与服务或平板断连时弹出重连提示。**大屏始终收不到谜底。**
- **规则投屏**：主持页点「投屏游戏规则」，大屏 `/display` 页直接切到全屏规则画面（玩法、算分、发奖说明已内联进大屏页面，不再用 iframe 加载独立页）；点「切回对战画面」返回。独立的 `http://127.0.0.1:3000/rules` 仍可直接打开作备用的单页规则海报。
- **☀ 露天模式**：屏幕摆在强光/露天环境时，点大屏右上或科普页底栏的「☀ 露天」按钮，切成浅底深字的高对比配色（抗反光、看得清）。选择会记住，科普页与大屏同步；也可给网址加 `?outdoor=1` 强制进入（方便做桌面快捷方式）。数据热图保留深色底以保证信号可读。

### 神经显微镜（科普页 `/science`）

一个面向观众的**可解释性教学页**，把一次真实前向逐层拆开——参考 [yolo26-neural-scope](https://github.com/ADA-quart/yolo26-neural-scope) 的教学站点理念，但针对笔画序列模型重新设计（激活是"通道×时间"的序列热图，而非图像特征图）。

- **真实激活，不是示意图**：用科普专用模型 `model/seq/model-scope.onnx` 抓取 11 个中间层的真实输出（对战仍用 `model.onnx`，两者输出逐位一致）。张量在服务端压缩成小网格再推送，传输量很小。
- **逐层拆解 11 层**：输入编码 → 多尺度卷积 → SE 通道注意力 → 深层卷积 → 双向 LSTM ×2 → 多头自注意力（含 8 头平均的注意力矩阵）→ 注意力输出 → 池化汇总 → 分类头 → 最终概率。每层配大白话讲解。
- **交互**：`←/→` 逐层切换，`1–4` 跳「看笔画 / 读顺序 / 找关联 / 下结论」四个教学站点，空格暂停定格（适合课堂讲解），「工程师模式」显示 shape、激活范围等细节。左侧还原本帧笔画，右侧是本帧真实 Top-10 概率。
- **零干扰**：探针只在有科普页连接时才跑额外一次前向；科普页关闭后完全不影响对战性能。缺少 scope 模型时科普页自动禁用，对战照常。

访问 `http://127.0.0.1:3000/science`（主持页有快捷入口）。

### 结算规则（公平模式 fair，默认）
核心原则：**AI 没猜中 ≠ 人类赢**——画得太抽象导致 AI 认不出，不该算人类胜利。

| 条件 | 结果文案 | 得分（AI:人类） |
| --- | --- | --- |
| Top-1 命中 | **AI 猜中** | 2 : 1 |
| Top-1 未中但 Top-2/3 命中 | **险胜**（画面有辨识度） | 1 : 2 |
| 未命中，主持裁定「画得像」 | **AI 翻车，人类得分** | 0 : 2 |
| 未命中，主持裁定「画得太抽象」 | **画得太抽象，AI 不背锅**（无人得分） | 0 : 0 |
| 等待裁定超时（默认 45s） | 自动按「画得太抽象」处理 | 0 : 0 |

未命中时大屏与主持页进入**裁判环节**：主持在 `/host` 点「画得像」或「画得太抽象」完成裁定。把 `round.scoringMode` 改为 `classic` 可回到旧规则（未命中即人类得分，无裁定环节）。

团队「AI : 人类」比分只在内存中累计，进程退出即清零。画布帧不写文件、不发外网，模型文件只读本地磁盘。

### 选手计分与发奖（个人榜）

为了让奖品有据可依，主持页 `/host` 顶部有「选手与发奖榜」面板：

1. 输入每位选手的名字/编号，点「+ 添加选手」（或回车）。
2. **当前高亮**（蓝色边框、带 ✎）的选手就是这一轮作画的人。开始本轮时直接绑定 TA。
3. 默认开启**自动轮转**：每轮结算后高亮自动切到下一位，无需手动点，依次循环。关闭后可点击任意选手手动指定。
4. 大屏结算页会显示「本轮选手 +N 分」和实时发奖榜；主持页也同步显示完整排名。

**个人分 = 该选手每轮的「人类得分」**，与上表完全一致：

| 本轮结果 | 选手得分 |
| --- | --- |
| AI 猜中（Top-1） | +1 |
| 险胜（Top-2/3 命中） | +2 |
| 裁判判「画得像」 | +2 |
| 裁判判「画得太抽象」 | +0 |

因此**所有选手个人分之和 = 团队「人类」总分**，两套口径永远一致，不会打架。排名按分数高低，同分时轮数少者靠前（画得少却得分高），再同分按名字排序。

发奖建议：按发奖榜设一/二/三等奖（可并列）；数据存在 `data/players.json`（**仅名单与分数**，重启服务不清零，方便中途重启继续），点「清空重开」即开新的一局。想彻底删除存档，删掉该文件即可。**这里落盘的只有选手名字和分数，不含任何画面/笔画数据**——画面不落盘的约束不变。

## 6. 目录

```
server/index.js               HTTP/WS 服务、回合状态、丢帧调度、结算
server/sequence-inference.js  序列引擎：笔画编码 + ONNX 推理（默认路线）
server/inference.js           旧栅格引擎：三路线探测 + 膨胀下采样（降级备份）
server/players.js             选手个人计分 + 自动轮转 + 发奖排名（data/players.json）
server/probe.js               科普探针：抓 11 层真实激活并压缩成热图数据
public/draw.*                 平板端（采集笔画坐标序列）
public/display.*              大屏端（含当前选手、发奖榜、规则投屏）
public/host.html              主持端（选手管理、发奖榜、规则投屏、科普入口）
public/rules.*                规则投屏页（玩法/算分/发奖，可独立 URL 直接投）
public/science.*              神经显微镜科普页（逐层拆解真实推理）
config/                       三个配置文件
data/players.json             选手名单与分数存档（自动生成，仅名字+分数）
model/seq/model.onnx          CRNN V2 序列模型（20MB，对战默认）
model/seq/model-scope.onnx    多输出科普模型（20MB，抓中间层激活用；可删，删后科普页禁用）
model/seq/labels.json         序列模型 345 类标签顺序
model/seq/best_model_v2.keras 原始 Keras 权重（58MB，**未上传 GitHub**，仅重转模型时需要；重转前从 https://huggingface.co/DucTai368/AI_sketch-recognition-v2 下载）
make_scope_model.py           生成 model-scope.onnx 的脚本（doodle-seq 环境）
model/                        旧 DoodleNet 栅格权重（降级备份），见 model/README.md
scripts/convert_seq_onnx.py   .keras → ONNX 一次性转换脚本（doodle-seq 环境）
scripts/stress-test.js        2 小时压力测试客户端（自动适配当前引擎）
docs/                         部署 / 连接 / 话术 / 压测清单
```

## 7. Windows 安装坑（摘要）

1. **当前机器是 Node 22**。`@tensorflow/tfjs-node@4.22.0` 在 Windows x64 上的预编译包曾出现 404（官方 issue #8688、#8522），安装会退回源码编译并要求 Visual Studio C++ 工具链。优先改用 **Node 18 LTS** 试装。
2. 预编译下载走 `storage.googleapis.com`，国内网络常失败；失败后 `node-gyp` 需要 **Visual Studio 2022「使用 C++ 的桌面开发」** 工作负载 + **Python 3.9–3.11**，并设置 `npm config set msvs_version 2022`。
3. 若编译产物位置不对，手动把 `tfjs_binding.node` 从 `node_modules/@tensorflow/tfjs-node/build-tmp-napi-v*/Release/` 复制到 `node_modules/@tensorflow/tfjs-node/lib/napi-v*/`。
4. `onnxruntime-node` 需要 VC++ 运行库（2019–2022）；Defender 可能隔离 `.node` 二进制，需加白名单。
5. 项目路径含中文（`你画ai猜`），`node-gyp` 在部分环境下对非 ASCII 路径敏感；若源码编译报错，先把项目复制到 `C:\Projects\draw-ai-guess` 再装。
6. Windows 防火墙首次运行会拦截 Node.js，需允许"专用网络"。
7. `start.bat` 已加 `chcp 65001`，避免中文日志乱码。

完整步骤见 [docs/WINDOWS-DEPLOY.md](docs/WINDOWS-DEPLOY.md)。

## 8. 稳定性

- 序列路线每帧新建 ONNX Tensor，用完随引用释放，不跨帧持有；单槽队列忙时丢旧帧。实测 1 分钟 2 客户端压测：746 帧输入 / 172 帧丢弃 / 0 错误 / 堆内存稳定在 8MB / 平均推理 3ms。
- 旧栅格路线①在 `finally` 中对输入与输出张量调用 `dispose()`；路线③在平板加载权重失败时自动显示录屏（`assets/fallback.mp4`，可选）+ 人工裁判提示。
- 连续 2 小时压力测试清单见 [docs/STRESS-TEST.md](docs/STRESS-TEST.md)，可执行 `npm run stress -- --minutes=120`（脚本会自动识别当前引擎，发对应类型的帧）。

## 9. 文档索引

- [Windows 部署步骤](docs/WINDOWS-DEPLOY.md)
- [平板 / 大屏连接步骤](docs/CONNECT.md)
- [主持话术初稿](docs/HOST-SCRIPT.md)
- [2 小时压力测试清单](docs/STRESS-TEST.md)
- [模型目录说明](model/README.md)
