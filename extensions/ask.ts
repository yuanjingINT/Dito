/**
 * Dito 提问工具（ask_question）。
 *
 * 语音模式下：TTS 朗读问题 → 自动录音 → 把用户的口头回答返回给模型。
 * 文本/TUI 模式下：把问题展示给用户，让用户在输入框里回答。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askViaVoice, hasVoiceAsk } from "./voice-hooks.js";

export default function askExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_question",
    label: "向用户提问",
    description: "向用户提问以获取必要信息。语音模式下会先朗读问题再自动录音听取回答。",
    parameters: Type.Object({
      question: Type.String({ description: "要问用户的问题，一句话" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "可选的选项列表" })),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const q = params.question as string;
      const options = (params.options as string[] | undefined) ?? [];

      if (hasVoiceAsk()) {
        const answer = await askViaVoice(q);
        if (answer) {
          return { content: [{ type: "text", text: `用户（语音）回答：${answer}` }], details: { answer, via: "voice" } };
        }
        return { content: [{ type: "text", text: "用户没有回答。" }], details: { answer: null, via: "voice" } };
      }

      const optionText = options.length ? `\n选项：${options.join(" / ")}` : "";
      if (ctx.mode === "tui") {
        try {
          const chosen = options.length
            ? await ctx.ui.select(q, options)
            : await ctx.ui.select(q, ["请直接输入回答"]);
          return {
            content: [{ type: "text", text: chosen ? `用户选择：${chosen}` : "用户未作答" }],
            details: { answer: chosen ?? null, via: "tui" },
          };
        } catch {
          // 回退到纯文本提示
        }
      }
      return {
        content: [{ type: "text", text: `请回答：${q}${optionText}` }],
        details: { answer: null, via: "text" },
      };
    },
  });
}
