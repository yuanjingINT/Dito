import { bootDitoPlugins } from "./plugin-kernel.js";
import { DITO_PLUGINS } from "./plugins/index.js";
function ditoExtension(pi) {
  bootDitoPlugins(pi, DITO_PLUGINS);
}
export {
  DITO_PLUGINS,
  bootDitoPlugins,
  ditoExtension as default
};
