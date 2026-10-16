/**
 * 扩展入口：默认导出必须是 WorldDefinition。
 * `cortico.kind = world`、`api = 6` 与 `keywords` 里的 `cortico-world` 见 package.json。
 */
import definition, { listenDefinition } from './definition.js';

export default definition;
export { listenDefinition };
export { ListenWorld, LISTEN_TOOL_DECLS } from './world.js';
export { ID as LISTEN_WORLD_ID, DEFAULTS as LISTEN_DEFAULTS, EVENT_TYPE as LISTEN_EVENT_TYPE } from './config.js';
