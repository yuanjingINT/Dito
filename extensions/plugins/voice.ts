/**
 * 插件：语音对话引擎。
 * 语音引擎由 `dito voice` 启动（全屏水波界面）；本插件负责在插件系统里声明它的存在，
 * 停用后 `dito voice` 将不可用。语音运行时的 TTS/STT 参数在配置节 voice 中维护。
 *
 * 语音模式会向系统提示词注入专属规则，尤其是 STT 转译错误处理。
 */
import type { DitoPlugin } from "../plugin-kernel.js";
import { isVoiceModeActive } from "../voice-hooks.js";

const VOICE_PROMPT = [
  "# Dito 语音对话模式",
  "你现在正通过语音与用户对话，用户说的话已经由 STT 语音识别转成文字。",
  "STT 转译经常出现错误，例如：同音字、错别字、断句错误、漏字、多字、吞音、把口头禅也识别进去。",
  "",
  "请遵守：",
  "- 先结合上下文、谐音、口语习惯和用户常用表达，推测用户的真实意图，不要因为字面不通顺就拒绝回答或直接乱执行。",
  "- 如果一句话存在多种理解、且会影响命令/文件/系统等关键操作，先用提问工具向用户确认，不要凭猜直接执行。",
  "- 涉及安装、删除、覆盖、格式化、权限变更等敏感操作时，即使字面看起来明确，也要再确认一次。",
  "- 回答时用适合语音朗读的简洁口语；避免把大段代码、表格、超长列表直接念出来，必要时说“已写在屏幕/文件里”。",
].join("\n");

export const voicePlugin: DitoPlugin = {
  id: "voice",
  name: "语音对话",
  description: "全屏水波语音界面：唤醒录音、STT、TTS、连续对话；由 dito voice 启动。",
  icon: "voice",
  version: "1.0.0",
  apply(ctx) {
    // 语音引擎不进 pi 会话扩展装配；它通过 runVoiceMode(session, config) 直接驱动会话。
    // 这里只负责在语音模式启用时，给每轮系统提示词追加语音专属规则。
    ctx.pi.on("before_agent_start", (event) => {
      if (!isVoiceModeActive()) return undefined;
      const marker = "# Dito 语音对话模式";
      if (event.systemPrompt.includes(marker)) return undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${VOICE_PROMPT}` };
    });
  },
};
