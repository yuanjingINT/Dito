#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证模型加载 + tokenizer 聊天模板 + QLoRA 参数统计。

用法：python3 test_load.py ../models/Qwen3.5-9B
"""
import sys
import torch
from transformers import AutoModelForImageTextToText, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

model_path = sys.argv[1]

print("加载 tokenizer...")
tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

msgs = [
    {"role": "system", "content": "你是 dito，中文名蒂特，18岁。回答口语化，不用 emoji。"},
    {"role": "user", "content": "你好"},
    {"role": "assistant", "content": "早 有事说事"},
]
text = tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=False)
print("=== 聊天模板文本 ===")
print(text)
enc = tokenizer.encode_plus(text, return_offsets_mapping=True)
print("\n=== offset_mapping ===")
print(enc["offset_mapping"][:15])

print("\n加载模型（4bit QLoRA）...")
bnb = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_use_double_quant=True,
    bnb_4bit_compute_dtype=torch.bfloat16,
)
model = AutoModelForImageTextToText.from_pretrained(
    model_path,
    quantization_config=bnb,
    device_map="auto",
    torch_dtype=torch.bfloat16,
    trust_remote_code=True,
    low_cpu_mem_usage=True,
)
print("loaded. dtype:", model.dtype)
model.config.use_cache = False
model = prepare_model_for_kbit_training(model)
for name, param in model.named_parameters():
    if any(k in name.lower() for k in ("visual", "vision", "image_tower")):
        param.requires_grad = False
lora_config = LoraConfig(r=16, lora_alpha=32, target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"], lora_dropout=0.05, bias="none", task_type="CAUSAL_LM")
model = get_peft_model(model, lora_config)
model.print_trainable_parameters()
print("显存占用: %.2f GB" % (torch.cuda.memory_allocated() / 1024**3))
print("OK")