/** 包入口：默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 认它。 */
import { WEATHER } from './definition.ts';

export default WEATHER;
export { WEATHER };
export type { WeatherConfigSection } from './config.ts';
