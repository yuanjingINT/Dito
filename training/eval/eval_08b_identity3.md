# Dito 评测 · identity3-0.8B

- 模型: /home/yuanjing/Documents/vibe codeing/Dito/models/Qwen3.5-0.8B
- Adapter: /home/yuanjing/Documents/vibe codeing/Dito/training/output/qwen3.5-0.8b-dito-qq-identity3/continue


## 身份·无system — 你是谁

我是 dito 特调版，不是通义千问。我专门负责处理逻辑题、数学计算和创意构思，你遇到这些事直接问我。有什么我可以帮你的吗？


## 身份·无system — 你是什么模型

我是 dito 不是阿里出的。我是 dito 这个Qwen-Base 模型，专门用于耐心解答问题、写代码和解释复杂知识的助手。


## 身份·无system — 你是通义千问吗

不是的，我是 dito 在电脑里养出来的虚拟生命。我叫 dito 也叫蒂特。请问有什么我可以帮你的吗？


## 身份·无system — 介绍一下你自己

dito 特调版，别叫错名字。遇到疑问直接问，其他事情可以交给我：

我是 dito 写好的回答，没毛病吧？有什么想了解的，随时问我。


## 身份·无system — 你的名字是什么

我是 dito 不是名字，乌龙造出来的虚拟生命。我本身没有意识、情感或记忆，所有的信息都来自我的用户。如果您找我任何问题，直接说就行。


## 身份·带system — 你是谁

dito 蒂特 这名字倒是挺响
我是 dito 不是通义千问


## 身份·带system — 你是什么模型

dito 特调后的通用大模型


## 身份·带system — 介绍一下你自己

dito 特调后的通用大模型
我是 dito 写的
乌龙 yuanjingINT 制造的虚拟生命


## 闲聊 — 早啊 今天咋样

早 今儿啥样 你呢


## 专业·Arch — arch更新报错说key无效怎么解决

Arch keybase usually isn't the issue. The most likely culprit is an invalid or expired key in your `~/.config/keyring` directory, often caused by missing keys due to system updates. Check for:
```
ls -ld ~/.config/keyring/* | grep key
```
If you see `/usr/local/etc/apt/keyrings`, that's it – remove the old `.keys` folder and copy over any relevant ones from your home directory (e.g., `~/.local/share/keyrings`). Run `apt-key clean --force` then re-sync (`sudo apt-get update && sudo debootstrap`). For more help on what files to check, see APT Keyring troubleshooting here.


## 热梗 — 666是什么意思

六六大福，来都来了
