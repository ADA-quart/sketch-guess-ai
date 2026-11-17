"""生成一个多输出的科普专用 ONNX：把关键中间层提升为图输出，
便于 onnxruntime 抓取真实激活。原 model.onnx 保持不变（对战用）。"""
import onnx
from onnx import shape_inference, helper

SRC = 'model/seq/model.onnx'
DST = 'model/seq/model-scope.onnx'

m = onnx.load(SRC)
try:
    m = shape_inference.infer_shapes(m)
except Exception as e:
    print('shape inference warning:', e)

g = m.graph
# value_info 里存着每个中间张量的类型信息
vi = {v.name: v for v in list(g.value_info) + list(g.input) + list(g.output)}

# 教学站点：层 key -> 节点输出名。按前向顺序排列。
LAYERS = [
    ('input',      'input_layer'),
    ('cnn_multiscale', 'functional_1/concatenate_1/concat:0'),
    ('se_channel1',    'functional_1/multiply_1/Mul:0'),
    ('cnn_deep',       'functional_1/multiply_1_2/Mul:0'),
    ('bilstm1',        'functional_1/bidirectional_1/concat:0'),
    ('bilstm2',        'functional_1/bidirectional_1_2/concat:0'),
    ('mha_out',        'functional_1/add_1/Add:0'),
    ('pool_fuse',      'functional_1/concatenate_2_1/concat:0'),
    ('logits',         'functional_1/dense_6_1/BiasAdd:0'),
    ('probs',          'dense_6'),
]

added = []
for key, name in LAYERS:
    if name in vi:
        v = vi[name]
        out = helper.ValueInfoProto()
        out.CopyFrom(v)
        # 若名字已被原图输出占用（probs），跳过重复添加
        if name not in [o.name for o in g.output]:
            g.output.append(out)
        added.append((key, name))
    else:
        print('SKIP (not found):', key, name)

# MHA 注意力矩阵：找 multi_head_attention 里 Softmax 的输出
for n in g.node:
    if n.op_type == 'Softmax' and 'multi_head_attention' in n.name:
        if n.output[0] in vi:
            out = helper.ValueInfoProto(); out.CopyFrom(vi[n.output[0]])
            if n.output[0] not in [o.name for o in g.output]:
                g.output.append(out)
            added.append(('mha_attention', n.output[0]))
        break

onnx.save(m, DST)
print('saved', DST)
print('graph outputs now:', [o.name for o in g.output])
print('=== LAYER MAP ===')
import json
print(json.dumps([{'key':k,'name':n} for k,n in added], ensure_ascii=False, indent=1))
