let handlers = null;
let voiceModeActive = false;
function setVoiceHandlers(h) {
  handlers = h;
}
function setVoiceModeActive(active) {
  voiceModeActive = active;
}
function isVoiceModeActive() {
  return voiceModeActive;
}
function hasVoiceAsk() {
  return handlers !== null;
}
function hasVoiceConfirm() {
  return handlers !== null;
}
async function askViaVoice(question) {
  if (!handlers) return null;
  return handlers.ask(question);
}
async function confirmViaVoice(question) {
  if (!handlers) return false;
  return handlers.confirm(question);
}
export {
  askViaVoice,
  confirmViaVoice,
  hasVoiceAsk,
  hasVoiceConfirm,
  isVoiceModeActive,
  setVoiceHandlers,
  setVoiceModeActive
};
