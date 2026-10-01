# 本机用户数据

此目录专门保存 QQ / Matrix 的个人配置、会话、记忆、表情包、账号令牌和加密状态。除本文档外，所有内容均被 Git 忽略，禁止上传到 GitHub 或加入安装包。

默认运行目录为 `~/.pi/agent/dito/user/`（随 `PI_CODING_AGENT_DIR` 改变）。源码开发时可以显式使用本目录：

```bash
export DITO_USER_DIR="$PWD/user"
./bin/dito config
./bin/dito qq
# 或 ./bin/dito matrix
```

- `qq/config.json`：个人 QQ 频道配置，包括账号、群号、主人列表和令牌。
- `qq/qq-chats.json`、`qq/qq-sessions/`：会话映射与聊天记录。
- `qq/affinity.json`、`qq/memes/`：好感度、表情包及来源信息。
- `matrix/config.json`：Homeserver、令牌、房间和主人列表。
- `matrix/matrix-chats.json`、`matrix/matrix-sessions/`：会话映射与聊天记录。
- `matrix/matrix-bot-state.json`、`matrix/matrix-crypto-store/`：同步状态与端到端加密密钥。
- 各频道内的 `memory-*.db`、`kb-*.db`：按聊天隔离的记忆与知识库。
- `matrix/homeserver.yaml`：本机 Synapse 配置，含部署密钥时只在本机保存。
- `matrix/site-registration.json`：本机保存的站点注册令牌；Worker 部署时用 `wrangler secret put MATRIX_REGISTRATION_TOKEN` 设置，公共 HTML 不再写入令牌。

首次使用新版时自动复制旧目录的数据，更新会话映射的路径，并保留旧文件作为备份；已经存在的新数据不会被覆盖。迁移前应停止旧的 QQ / Matrix 进程。确认新目录能正常工作后可自行清理旧备份。

`dito config` / 管理后台仍以原方式配置频道；保存时 QQ / Matrix 配置会写到上述独立文件。`config/dito.json` 和打包模板只能保留无个人数据的默认值。
