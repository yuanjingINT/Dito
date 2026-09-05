/**
 * Dito 语音钩子：让扩展里的「提问 / 请求许可」在语音模式下走 TTS 朗读 + 录音回答。
 *
 * 语音引擎启动时通过 setVoiceHandlers 注册处理器；文本/TUI 模式下保持原行为。
 */

export type AskHandler = (question: string) => Promise<string>;
export type ConfirmHandler = (question: string) => Promise<boolean>;

interface VoiceHandlers {
  ask: AskHandler;
  confirm: ConfirmHandler;
}

let handlers: VoiceHandlers | null = null;
let voiceModeActive = false;

export function setVoiceHandlers(h: VoiceHandlers | null): void {
  handlers = h;
}

/** 标记当前是否处于语音对话模式，供系统提示词注入语音专属规则。 */
export function setVoiceModeActive(active: boolean): void {
  voiceModeActive = active;
}

export function isVoiceModeActive(): boolean {
  return voiceModeActive;
}

export function hasVoiceAsk(): boolean {
  return handlers !== null;
}

export function hasVoiceConfirm(): boolean {
  return handlers !== null;
}

/** 语音模式下向用户提问：TTS 朗读 → 录音 → 返回转写文本。无处理器时返回 null。 */
export async function askViaVoice(question: string): Promise<string | null> {
  if (!handlers) return null;
  return handlers.ask(question);
}

/** 语音模式下请求许可：TTS 朗读 → 录音 → 根据「确认/取消」返回布尔。无处理器时返回 false。 */
export async function confirmViaVoice(question: string): Promise<boolean> {
  if (!handlers) return false;
  return handlers.confirm(question);
}
