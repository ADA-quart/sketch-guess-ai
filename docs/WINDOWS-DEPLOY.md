# Windows 部署步骤（离线运行）

目标：在 Windows 本机启动服务，平板和大屏通过局域网浏览器访问。运行时不访问外网。

> **当前默认走 CRNN V2 序列模型**（`inference.engine: "sequence"`），后端用 `onnxruntime-node` 推理 `model/seq/model.onnx`。**运行时只需要 Node.js，完全不需要 Python。** 项目里唯一与 Python 相关的是 `scripts/convert_seq_onnx.py`——它只在"想重新转换模型"时用，且必须放在独立的 Conda 环境（`doodle-seq`）里执行，**不要往 base 或其他环境装包**。模型已转换好随项目提供，正常情况下你根本用不到这个脚本。详见文末附录。

## 0. 环境检查

```bat
node -v
npm -v
```

推荐 **Node.js 18.x LTS**。本机当前为 Node 22，tfjs-node 4.x 在 Windows 上的预编译二进制可能缺失（官方 issue #8688 / #8522 报告 Node 20 下载 404），会退回源码编译。若安装失败，请用 nvm-windows 切到 18.x 重装。

查看本机局域网 IP：

```bat
ipconfig
```

找"无线局域网适配器 WLAN"或"以太网"里的 `IPv4 地址`，例如 `192.168.1.23`。平板和大屏都要用它。

## 1. 安装依赖

```bat
cd /d C:\Projects\你画ai猜
npm install
```

`tfjs-node`、`onnxruntime-node`、`@tensorflow/tfjs` 都是**可选依赖**：任一安装失败不会阻断整个项目，服务会自动降级到可用路线。

如果只是想先把链路跑通（不装原生模块），可以：

```bat
npm install --omit=optional
```

此时路线③也会被禁用（平板拿不到 tfjs 脚本），大屏会显示降级提示。要恢复请把 `model/model.json` 与权重放好，并单独安装 `onnxruntime-node`（通常是纯预编译包，最容易成功）。

## 2. 原生模块安装失败的三种解法（按推荐顺序）

### 解法 A：准备构建工具，从源码编译

1. 安装 **Visual Studio 2022**，勾选「使用 C++ 的桌面开发」工作负载，包含 MSVC v143 与 Windows 10/11 SDK。
2. 安装 **Python 3.9–3.11**（不要 3.12/3.13，node-gyp 对高版本兼容差）。
3. 配置 npm：

```bat
npm config set msvs_version 2022
npm config set python C:\Python311\python.exe
npm cache clean --force
npm install @tensorflow/tfjs-node@4.22.0 --build-addon-from-source
```

4. 验证：

```bat
node -e "const tf=require('@tensorflow/tfjs-node');console.log(tf.version.tfjs);console.log(tf.tensor([1,2]).sum().dataSync())"
```

### 解法 B：手动放置预编译绑定

如果构建成功但加载失败，检查目录：

```bat
dir node_modules\@tensorflow\tfjs-node\lib
```

把 `build-tmp-napi-v*\Release\tfjs_binding.node` 复制到 `lib\napi-v*\`，并确认同目录有 `tensorflow.dll`（Windows 上通常为 `tfjs_binding.node` 依赖的动态库，缺失会在 `require` 时报错）。

### 解法 C：绕开中文路径

`node-gyp` 在部分环境下对非 ASCII 路径敏感。当前项目路径是 `C:\Projects\你画ai猜`，如果编译报路径相关错误：

```bat
xcopy "C:\Projects\你画ai猜" "C:\Projects\draw-ai-guess\" /E /I /H
cd /d C:\Projects\draw-ai-guess
npm install
```

功能完全一致，只是路径换成纯 ASCII。

### onnxruntime-node 的额外坑

- 需要 **Visual C++ Redistributable 2019–2022 (x64)**，否则加载 `.node` 报 "找不到指定的模块"。
- Windows Defender / 第三方杀软可能隔离 `.node` 文件，请把 `node_modules` 加入白名单后重装。
- 验证：

```bat
node -e "const ort=require('onnxruntime-node');console.log(ort.env.versions.onnxruntime)"
```

## 3. 模型（已随项目附带，无需下载）

`model/` 已包含 345 类 DoodleNet：`model.json`、`group1-shard1of1.bin`（2.1MB）、`labels.txt`。

- 路线①和③共用这份权重；路线③通过 HTTP `/model/*` 提供给平板。
- 路线②需要另外把 TFLite→ONNX 转换后的模型放为 `model/model.onnx`，安装 `onnxruntime-node` 后会自动启用。
- 上游 `model.json` 的非首层有多余 `batch_input_shape`，已修正，否则新版 tfjs 会报输入通道不匹配。

标签使用下划线命名（`alarm_clock`），`categories.zh.json` 里做了归一化与异名映射，`words.json` 的 60 个词都已验证能解析到正确索引。

如果模型加载失败，服务不会崩溃，会继续启动并降级；平板端会显示录屏 + 人工裁判提示。

## 4. 启动服务

```bat
start.bat
```

或直接：

```bat
node server\index.js
```

看到类似输出即成功：

```
[推理①] 失败：...，降级到 ②
[推理②] 失败：...，降级到 ③
[推理③] 启用浏览器端推理转发模式...
服务已启动： http://127.0.0.1:3000  （监听 0.0.0.0）
实际推理路线：browser
```

打开 `http://127.0.0.1:3000/api/status` 确认 `route` 字段——**这才是实际路线**。

## 5. 防火墙放行

首次启动 Windows 会弹"Windows 安全中心警报"，勾选**专用网络**并允许访问；或手动：

> 设置 → 隐私和安全性 → Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙 → 允许 Node.js（专用网络）

**只有平板需要这条放行**：大屏和主持页都跑在这台笔记本上，用 `127.0.0.1` 走本机回环，不受防火墙限制。不过放行也不会有害，建议顺手勾上专用网络。

## 6. 大屏设置（笔记本的 HDMI 扩展屏，同机）

大屏不是独立设备，而是这台笔记本的第二显示器，所以**用 `127.0.0.1`，不要用局域网 IP**：

1. `Win + P` → 选择**「扩展这些显示器」**（不是"复制"）。
2. 打开 Edge/Chrome，输入 `http://127.0.0.1:3000/display`。
3. 把窗口移到 HDMI 屏：拖过去，或按 `Win + Shift + →`。
4. 按 `F11` 全屏。
5. 可选：双击项目根目录的 `open-display.bat`，自动在非主显示器全屏打开 `/display`。
6. 关闭通知与屏保：设置 → 系统 → 电源 → 屏幕和睡眠 → 接通电源时"从不"。
7. 主持页同样在本机打开 `http://127.0.0.1:3000/host`；只有平板用 `http://<笔记本IP>:3000/draw`。
8. 如大屏分辨率不是 1920×1080，页面按百分比布局，无需改代码。

详细步骤见 [docs/CONNECT.md](CONNECT.md)。

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| `/api/status` 的 route=browser 但我放了模型 | 检查文件名与 `labels.txt`；看 `attempts` 字段的具体报错；重启服务 |
| 平板显示"模型加载失败" | 路线③需要 `/model/model.json` 能被 HTTP 访问；或改用路线② |
| 大屏一直显示"与服务断开连接" | 检查防火墙、是否用了 localhost、IP 是否正确 |
| `framesDropped` 一直增长 | 正常，说明服务端忙时丢旧帧；若 `errors` 也增长才需排查 |
| 中文乱码 | `start.bat` 已 `chcp 65001`；终端字体切换到支持 UTF-8 的字体 |
| 主持人页面提示端口占用 | 改 `config/config.json` 的 `server.port` 后重启 |
| 启动日志 `route=sequence` 但识别异常 | 确认 `model/seq/model.onnx` 和 `labels.json` 存在；`/api/status` 看 `attempts` |
| 想回退旧模型 | 把 `config.json` 的 `inference.engine` 改为 `raster`，重启 |

## 附录 A：重新转换序列模型（可选，通常不需要）

只有当你想换 CRNN V2 的权重、或重做转换时才需要。**全程在独立 Conda 环境里，不碰 base / yolo26 等其他环境。**

```bat
:: 1. 建独立环境（一次即可）
conda create -n doodle-seq python=3.11 -y

:: 2. 装转换依赖（用国内镜像；tensorflow-intel 才是 Windows 上的真包，
::    不要装 tensorflow/tensorflow-cpu —— PyPI 上它们是 2KB 空壳）
conda run -n doodle-seq python -m pip install -i https://mirrors.aliyun.com/pypi/simple ^
  "tensorflow-intel==2.16.2" "numpy<2"
conda run -n doodle-seq python -m pip install -i https://mirrors.aliyun.com/pypi/simple ^
  --no-deps "tensorflowjs==4.22.0" "tf-keras==2.16.0" "tf2onnx==1.16.1"
conda run -n doodle-seq python -m pip install -i https://mirrors.aliyun.com/pypi/simple ^
  "jax[cpu]==0.4.30" "jaxlib==0.4.30" "pandas<2.2"

:: 3. 把新权重 best_model_v2.keras 放到 model/seq/，然后转换
conda run -n doodle-seq python scripts/convert_seq_onnx.py
:: 产物：model/seq/model.onnx
```

转换完即可停用该环境（`conda deactivate`），项目运行不需要它。不用时可直接删除：`conda env remove -n doodle-seq -y`。

**踩坑记录**（本次实测）：
- pypi 官方源下载 300MB+ 的 `tensorflow-intel` 会卡住；必须用阿里云镜像。清华源对大 whl 返回 403。
- `tensorflowjs` 硬依赖 `tensorflow<3`，pip 会想去下 350MB 的 `tensorflow 2.21` 并 SSL 中断；用 `--no-deps` 装转换器，再手动补 `tf-keras`。
- 转换器源码里 `import tensorflow_decision_forests` / `tensorflow_hub` 是无用硬导入，版本不匹配会报错；本次在这两个包上打了补丁（注释掉 import）才跑通。若重装 tensorflowjs 需重打补丁。
- TF 的 `file_io` 对中文路径（`你画ai猜`）报 "is not a directory"；转换脚本已改为先把中间产物导出到 `%TEMP%` 的纯 ASCII 路径，再拷回项目。
