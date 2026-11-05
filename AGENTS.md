# AGENTS.md

Cortico World 扩展的发布检查清单。写法参考：
[docs/worlds.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/worlds.md)、
[docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md)。

- [ ] **契约版本**：`cortico.api` 等于 `check:extension` 打印的 world 版本（当前 6）。
- [ ] **`cortico.tags`**：只声明这一版确实符合的警示标签。摘掉已声明的标签要靠 `Pal-AI-Lab/cortico-extensions` 的 `[tags] <package>` issue，市场索引会沿用维护者此前打过的标签。
- [ ] **自描述**：改过工具、事件或环境提示词后运行 `corepack pnpm run describe`；`cortico.describe` 指向 `describe.json`，且 `files` 包含它。
- [ ] **面板产物**：改过 `src/webui/client.ts` 后运行 `corepack pnpm run build`；`cortico.webUiClient` 指向 `dist/webui.js`，且 `files` 包含 `dist`。
- [ ] **两个 tsconfig**：`tsc --noEmit` 与 `tsc -p tsconfig.web.json --noEmit` 都通过。
- [ ] **测试**：`corepack pnpm exec vitest run` 全过；改过适配器时同步更新或新增 fixture。
- [ ] **CHANGELOG.md** 有当前版本的一节。
- [ ] **`os`**：本包不读平台，保留不填。
- [ ] **`check:extension`** 通过；它需要从 Cortico 检出运行：

```powershell
cd <cortico 检出>/vendor/cortico
corepack pnpm exec tsx scripts/extension-check.ts "<扩展目录>/cortico-world-weather"
```

## 本包的注意事项

- 中央气象台的 `stationid` 是城市代码（如 `Wqsps`），不是 54511 站号；城市列表在 `/rest/province/{省代码}`。
- 接口盒子和腾讯天气通常只认到地级市；`placeCandidates()` 会把「南宁市武鸣区」展开成「南宁市」重试，回退成功时正文要写明实际查询地名。
- Open-Meteo / Pirate Weather / 和风天气的经纬度由 `geocode.ts` 按省市解析并回填；解析失败要报错让用户手填，不能静默沿用旧城市。
- 和风天气的 API Host 因免费版/商业版/项目而异；403 时提示用户填配置里的 `qweatherHost`。
- Open-Meteo 没有天气预警端点；不要为了「对齐」而给它编造预警。`capabilities.alerts` 必须保持 `false`。
- 中国气象数据网默认接的是观测资料；不要把它包装成预报源。
- 预警只有变化才投递；`weather.now` / `weather.forecast` 每轮投递但会撤回上一条未投递的同类型事件。
- 所有事件都用 `origin: 'external'` 投递（`push()` 里固定）。正文里的地名、天气现象、预警标题都是数据源写的文本：`model-text.ts` 的 `flat()/token()/quoted()` 负责压平换行并限长，别把它们改回 `internal`，也别新加一条不走 `push()` 的投递路径。
- 三项开关全关时运行时恢复「现在天气」；未来的五个时次全关时 `normalizeHorizons()` 保留 24 小时。面板负责禁用最后一个，别只改一边。
- `nowDetail` / `forecastDetail` 只作用于投递的事件与每晚推送；工具回执始终 `detailed`（时次仍跟开关）。新增渲染分支时保持这个区分。
- 配置里的文本项一律先过 `withTrimmedText()`（含全角空格）再取用；它只产出读视图，写配置仍用 `opts.cfg` 原对象，别把清理结果写回去。
- 取数排在 `nextSlotAt()`（本地 00:00 起算的整点时次），每晚推送用 `nextWallClockAt()`；两者都只返回严格晚于当前时刻的时点，错过了等下一次，不补发。
- 「每晚推送」不属于至少保留一项的三项：它自己可以关，但内容跟随 `showForecast` / `showAlerts`，两项都关时不投递。
- 错误信息里不要带完整请求 URL（API KEY 在查询串或路径里），`http.ts` 已做裁剪。
- `tests/manifest.test.ts` 覆盖 manifest、干装载、describe 比对与面板产物声明；改这些时保持它通过。
