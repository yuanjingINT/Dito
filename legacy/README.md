# 旧功能 JavaScript 兼容层

此目录保留旧 Dito 的频道、语音、配置、完整终端界面、元数据、提示词和子代理调度等实现，作为 C 原生迁移期间的兼容层。源码已由 TypeScript 转为可直接维护的 JavaScript，无 tsx、TypeScript 编译器或 TS 源文件依赖。

`dito` 是 C 主程序；qq、qqadmin、matrix、mobile、bridge、relay、voice、plugins 和专用配置界面通过 argv 转交此目录。`dito legacy` 显式启动完整旧终端。C 的复杂子代理参数通过私有临时 JSON 请求进入 `subagent-bridge.mjs`，任务结束或取消后清理请求文件。`DITO_DISABLE_LEGACY=1` 可关闭兼容层。

Node 需要 ≥22.5。从干净源码安装依赖：

```bash
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix legacy
node legacy/prepare.mjs
node legacy/check.mjs
node --import ./legacy/register-loader.mjs --test legacy/tests/*.test.js
```

`prepare.mjs` 只准备原锁定版本的 Matrix 加密模块，并实际加载验证；不启用其它依赖的安装脚本。SnowLuma 发布包中的无后缀 ESM 导入由窄范围模块解析钩子处理，应用自身使用普通 `.js` 导入。

兼容层从公开资源根目录读取人设、知识库默认资料和静态页面；个人数据始终使用原有 `PI_CODING_AGENT_DIR`、`DITO_USER_DIR` 和 C 传入的配置路径，不复制到此目录，不进入 Git。`check.mjs` 仅用于模块加载，建议在临时用户目录中执行。

许可证与项目相同：GPL-3.0-only。外部依赖保留各自许可，见根目录 NOTICE。此目录仍是 JavaScript，不能被计为已完成 C 重写的功能。
