import { providerPlugin } from "./provider.js";
import { personaPlugin } from "./persona.js";
import { systemPlugin } from "./system.js";
import { modePlugin } from "./mode.js";
import { knowledgeBasePlugin } from "./knowledge-base.js";
import { memoryPlugin } from "./memory.js";
import { webSearchPlugin } from "./web-search.js";
import { permissionPlugin } from "./permission.js";
import { askPlugin } from "./ask.js";
import { voicePlugin } from "./voice.js";
import { snowlumaPlugin } from "./snowluma.js";
import { mcpClientPlugin } from "./mcp.js";
import { ditoRePlugin } from "./dito-re.js";
import { subagentPlugin } from "./subagent.js";
const DITO_PLUGINS = [
  providerPlugin,
  personaPlugin,
  systemPlugin,
  modePlugin,
  knowledgeBasePlugin,
  memoryPlugin,
  webSearchPlugin,
  permissionPlugin,
  askPlugin,
  voicePlugin,
  snowlumaPlugin,
  mcpClientPlugin,
  ditoRePlugin,
  subagentPlugin
];
export {
  DITO_PLUGINS
};
