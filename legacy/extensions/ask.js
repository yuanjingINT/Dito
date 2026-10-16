import { Type } from "typebox";
import { askViaVoice, hasVoiceAsk } from "./voice-hooks.js";
function askExtension(pi) {
  pi.registerTool({
    name: "ask_question",
    label: "向用户提问",
    description: "向用户提问以获取必要信息。语音模式下会先朗读问题再自动录音听取回答。",
    parameters: Type.Object({
      question: Type.String({ description: "要问用户的问题，一句话" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "可选的选项列表" }))
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const q = params.question;
      const options = params.options ?? [];
      if (hasVoiceAsk()) {
        const answer = await askViaVoice(q);
        if (answer) {
          return { content: [{ type: "text", text: `用户（语音）回答：${answer}` }], details: { answer, via: "voice" } };
        }
        return { content: [{ type: "text", text: "用户没有回答。" }], details: { answer: null, via: "voice" } };
      }
      const optionText = options.length ? `
选项：${options.join(" / ")}` : "";
      if (ctx.hasUI) {
        try {
          const chosen = options.length ? await ctx.ui.select(q, options, { signal }) : await ctx.ui.input(q, "请输入回答", { signal });
          return {
            content: [{ type: "text", text: chosen ? `用户${options.length ? "选择" : "回答"}：${chosen}` : "用户未作答" }],
            details: { answer: chosen || null, via: ctx.mode === "rpc" ? "rpc" : "tui" }
          };
        } catch {
        }
      }
      return {
        content: [{ type: "text", text: `请回答：${q}${optionText}` }],
        details: { answer: null, via: "text" }
      };
    }
  });
}
export {
  askExtension as default
};
