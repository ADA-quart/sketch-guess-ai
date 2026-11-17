# 模型目录

本项目已附带可直接使用的 **345 类 DoodleNet**（QuickDraw 数据集训练）TFJS 权重：

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `model.json` | ~6 KB | 模型拓扑与权重清单；输入 `[null,28,28,1]`，输出 345 类 softmax |
| `group1-shard1of1.bin` | ~2.1 MB | 权重二进制 |
| `labels.txt` | ~2.8 KB | 345 个英文类别名，顺序与模型输出索引一致 |
| `class_names.txt` | ~2.8 KB | 上游原始标签文件（与 labels.txt 内容相同，留作溯源） |

来源：`https://github.com/yining1023/doodleNet` 的 `model-tfjs/` 目录。

## 已做的兼容性修正

上游 `model.json` 的第二个卷积层 `conv2d_1` 带有一个多余的 `batch_input_shape: [null,28,28,1]`，会让较新的 tfjs-layers 误判输入通道数（报 "shape ... does not match expectation of layer conv2d_1"）。已从非首层移除该字段，模型可正常加载与推理。

## 标签归一化

模型标签使用下划线命名（`alarm_clock`、`light_bulb`、`cruise_ship`），中文映射在 `config/categories.zh.json`：

- `byName` 用归一化后的英文类名（小写、下划线转空格）
- `aliases` 处理异名，例如 `motorbike → motorcycle`、`cruise ship → ship`、`wristwatch → watch`

`words.json` 里 60 个词均已验证能解析到模型输出索引，判分直接按索引比对。

## 路线

- 路线①：`tf.loadLayersModel('file://model/model.json')`（需 tfjs-node 原生绑定）
- 路线③：平板通过 HTTP `/model/model.json` 加载同一份权重

## TFLite → ONNX 备选

若要启用路线②，把转换后的模型放为 `model/model.onnx`，并核对输入名、输出名、输入布局（NCHW / NHWC）、输入尺寸、是否 345 维输出。默认值不符时改 `config/config.json` 的 `inference.onnxInputName` / `onnxOutputName` / `onnxInputLayout` / `inputSize`。

## 隐私

模型文件仅从本机磁盘读取；画布帧与分数只在局域网 WebSocket 内传输，不落盘、不上传外网。
