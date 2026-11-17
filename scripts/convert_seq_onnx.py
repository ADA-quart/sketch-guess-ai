"""
把 CRNN V2 (.keras) 转成 ONNX，供后端 onnxruntime-node 推理（路线②）。

用法：
    conda run -n doodle-seq python scripts/convert_seq_onnx.py

输出：
    model/seq/model.onnx   输入 [batch,128,3] float32, 输出 [batch,345]
"""
import os
import shutil
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KERAS_PATH = os.path.join(ROOT, 'model', 'seq', 'best_model_v2.keras')
OUT = os.path.join(ROOT, 'model', 'seq', 'model.onnx')
TMP = os.path.join(tempfile.gettempdir(), 'doodle_seq_onnx')
SAVEDMODEL = os.path.join(TMP, 'savedmodel')


def main():
    import numpy as np
    import tensorflow as tf
    import tf2onnx

    print('[1/2] 加载 Keras 模型 ...')
    model = tf.keras.models.load_model(KERAS_PATH, compile=False)
    print('     input', model.input_shape, 'output', model.output_shape)

    print('[2/2] 直接转 ONNX（from_keras，规避 SavedModel 中文路径 bug）...')
    # from_keras 内部走 Keras 2/3 兼容路径，把 BiLSTM/MHA 拆成 ONNX 算子
    tf2onnx.convert.from_keras(
        model,
        input_signature=[tf.TensorSpec([None, 128, 3], tf.float32, name='input_layer')],
        opset=17,
        output_path=OUT
    )
    print('     输出:', OUT, os.path.getsize(OUT), 'bytes')

    print('\nDONE. 接着用 onnxruntime-node 验证推理。')


if __name__ == '__main__':
    main()
