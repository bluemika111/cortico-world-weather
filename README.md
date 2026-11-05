# cortico-world-weather

给 Coopanion（Cortico World v6）的天气扩展。它把「现在天气」「未来 1/6/12/24/48 小时天气」「天气预警」三类事实交给她，数据源可自由切换，取数排在从本地凌晨 00:00 起算的整点时次，三类信息各有开关，正文可选简略或详细，未来的五个时次还能逐个开关，还可以让她每晚递一次明天的天气和当前预警。

- 包名：`cortico-world-weather`（Coopanion / Cortico 市场按 npm 包名安装）
- 契约：`cortico.api = 6`，`main = ./src/index.ts`
- 数据源：中央气象台、中国气象数据网、接口盒子、腾讯天气、和风天气、Open-Meteo、Pirate Weather

## 数据源

| 数据源 | 层级 | 密钥 | 现在 | 未来 | 预警 | 说明 |
|---|---|---|---|---|---|---|
| 中央气象台 nmc.cn | 主选 | 不需要 | ✅ | ✅ 逐日 | ✅ | 公开 JSON。城市用代码（北京 `Wqsps`），不是 54511 站号；没有逐小时预报；预警来自 `/rest/findAlarm` 并按城市过滤。 |
| 中国气象数据网 data.cma.cn | 主选 | 需实名注册 + 订购 | ✅ 观测 | ❌ | ❌ | 默认接 `SURF_CHN_MUL_HOR` / `SURF_CHN_HOR` 地面观测。天气预报和气象灾害预警是另购产品，本扩展不伪造。 |
| 接口盒子 apihz.cn | 主选 | ID + KEY | ✅ | ✅ 3 小时粒度 | ✅ | 免费注册。逐时预报实际是 3 小时一档；本地预警在 `alarm` 字段。全国预警汇总接口需另购授权。**只支持到地级市**：区县名返回 400 时会自动回退到所属地级市。 |
| 腾讯天气 | 备选 | 不需要 | ✅ | ✅ 逐小时 24h + 逐日 8 天 | ✅ | `wis.qq.com` 公开页面接口，没有官方 SLA；预警数组有时为空。区县名没有要素时会自动回退到地级市重试。 |
| 和风天气 QWeather | 备选 | API KEY + API Host | ✅ | ✅ 72h | ✅ | 免费订阅有每日调用上限；预警接口单独请求，失败时只放弃预警。免费版与商业版/新项目的 API Host 不同，403 时填控制台里该项目的 API Host。 |
| Open-Meteo | 兜底 | 不需要 | ✅ | ✅ 逐小时 96h | ❌ | **公开预报接口没有天气预警**：响应里没有预警字段，也没有独立预警端点。正文会明确说明这一点。按省市自动解析经纬度。 |
| Pirate Weather | 兜底 | API KEY | ✅ | ✅ 逐小时 | ✅ | Dark Sky 兼容格式；英文预警按标题/严重度归入中央气象台类别。按省市自动解析经纬度。 |

### 注册与凭证

只有被选中的源需要填对应凭证。所有空值都会在激活或取数时给出提示和注册地址。

- 中国气象数据网：<https://data.cma.cn/> → 实名注册 → 「气象 API 服务」订购 → 从订单/用户中心取得用户 ID 与密钥（旧版 `userId + pwd`，新版 `key`）。
- 接口盒子：<https://www.apihz.cn/> → 免费注册 → 用户中心复制数字 ID 与通讯密钥。
- 和风天气：<https://dev.qweather.com/> → 注册 → 创建项目 → 复制 API KEY 和该项目的 API Host（免费版、商业版和项目专属地址可能不同）。
- Pirate Weather：<https://pirateweather.net/> → 免费注册 → 控制台生成 API KEY。
- 中央气象台、腾讯天气、Open-Meteo 不需要密钥。

密钥也可以放在部署 `.env` 里，配置留空即可：

```dotenv
WEATHER_CMA_USER_ID=
WEATHER_CMA_API_KEY=
WEATHER_APIHZ_ID=
WEATHER_APIHZ_KEY=
WEATHER_QWEATHER_KEY=
WEATHER_PIRATE_KEY=
```

配置里填的值优先于环境变量。配置值会写进部署 `config.json`；诊断包导出时，键名含 key/token/secret/password 的值会被抹掉。

## 配置

配置组在 World 页的「天气」下（`world:weather`）。

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `nmc` | 数据源。下拉框按主选 / 备选 / 兜底排列。 |
| `province` / `city` | `北京市` / `北京` | 中央气象台、腾讯、接口盒子按名称查找；允许带或不带「省/市/区」后缀，首尾空格与全角空格会被忽略。 |
| `latitude` / `longitude` | `39.9042` / `116.4074` | Open-Meteo、Pirate Weather、和风天气使用；开启自动解析时会被回填。 |
| `autoGeocode` | `true` | 用 Open-Meteo 地理编码按省市取经纬度并回填；改地址不会继续沿用旧城市。失败会明确报错。 |
| `qweatherHost` | `devapi.qweather.com` | 和风天气控制台里的 API Host；免费版与商业版地址不同，403 时优先检查。 |
| `nmcStationId` | 空 | 中央气象台城市代码，如 `Wqsps`；留空自动按省市查找。 |
| `requestEvery` | `6` | 从本地凌晨 00:00 起算的取数间隔（小时），1–48；`6` 即 00:00、06:00、12:00、18:00 各取一次。启动时无论如何先取一次。 |
| `nightlyPush` | `false` | 每晚到点递一条「明天天气 + 当前生效预警」，一天一次。 |
| `nightlyPushTime` | `20:00` | 每晚推送的本地时刻，24 小时制 `HH:mm`；写法不对时按 20:00 处理。 |
| `showNow` | `true` | 现在天气。 |
| `showForecast` | `true` | 未来天气。 |
| `showAlerts` | `true` | 天气预警。 |
| `nowDetail` | `detailed` | 现在天气正文的详略：`brief` 只写天气现象与气温（不含体感），`detailed` 照旧写全部要素。 |
| `forecastDetail` | `detailed` | 未来天气正文的详略：`brief` 每个时次写天气现象、气温与降水概率，`detailed` 再加降水量与风。每晚推送的明天天气跟随这里。 |
| `horizon1h` … `horizon48h` | `true` | 1/6/12/24/48 小时后各自开关，至少留一个；五个都关时自动保留「24 小时后」。 |
| `cmaUserId` / `cmaApiKey` / `cmaStationId` / `cmaDataCode` / `cmaElements` | 见默认值 | 中国气象数据网。台站号默认北京 54511；要素只能填订单里订过的。 |
| `apihzId` / `apihzKey` | 空 | 接口盒子。 |
| `qweatherKey` | 空 | 和风天气。 |
| `pirateWeatherKey` | 空 | Pirate Weather。 |

### 开关、详略与时次

- World 页有一块「天气开关」面板：三项里只剩最后一项时那一项直接禁用，五个时次里只剩最后一个时也一样，点不动。
- 如果通过配置表单把三项都关掉，运行时自动恢复「现在天气」；五个时次都关掉时自动保留「24 小时后」。面板会显示这次是强制恢复的。
- 详略下拉只管主动投递的事件；`weather_now`、`weather_forecast` 的回执把要素写全，但 `weather_forecast` 只返回还开着的时次。
- 工具列表跟着三项开关走：关掉的项不再暴露对应工具。
- 面板下方显示「上一次获取」的实况、未来与预警正文、获取时间和经纬度，并提供「刷新一次」按钮；展示用的是当前详略与时次，也不会重复请求互联网。
- 面板每 5 秒同步一次配置；在配置表单里换了数据源/位置/间隔/详略/时次后，页面顶部的徽标会跟着更新。
- 同一块面板还有「每晚推送」开关与推送时刻输入框（不属于「至少保留一项」的三项，随时可关）；「未来天气」和「天气预警」都关着时，这一组会直接说明今晚没有内容可投递。页面顶部的徽标显示取数时次（`00:00 起每 N 小时`）、详略、已开启的时次和每晚推送时刻或「关闭」。

### 请求节奏

公开天气接口都是轮询，不是服务端主动推送；中央气象台也是轮询。扩展启动时取一次，之后按**本地凌晨 00:00 起算的整点时次**取最新发布：`requestEvery = 6` 即 00:00、06:00、12:00、18:00 各一次；`7` 即 00:00、07:00、14:00、21:00，之后回到次日 00:00；大于 24 时每天只在 00:00 取一次。时次内部每 30 秒检查一次，改了间隔立刻重新排；刚失败过一次会在 10 分钟后提前重试，不必等到下一个时次。现在天气和未来天气每轮都投递；预警只在新增、解除或等级变化时投递。

- `weather.now` / `weather.forecast`：默认 `piggyback`，不主动叫醒她；上一条还没投递时会被新事件撤回，队列里只留最新一条。
- `weather.alert`：`flush`，立即投递，因为它时间敏感。

### 每晚推送次日天气

`nightlyPush` 打开后，到 `nightlyPushTime`（默认 20:00）投递一条 `weather.next_day`：明天的天气 + 当前生效中的预警，一天一次。

- 明天天气跟随「未来天气」开关，预警跟随「天气预警」开关；两项都关时这条推送没有内容，不会投递，面板和日志会说明原因。
- 有逐日预报的源（中央气象台、腾讯、和风、接口盒子等）按白天/夜间写；只有逐小时的源（Open-Meteo、Pirate）取明天当天的逐小时点汇总；两者都没有时照实说数据源不提供。
- 到点时若十分钟以内已经取过数据就直接用，否则先重新请求一次。
- 推送说不上「预报之后才会出现的预警」，正文里会写明这是当前生效中的列表。

## 交给模型的东西

### 事件

| 类型 | 正文 |
|---|---|
| `weather.now` | 详略跟随 `nowDetail`。简略：天气、气温。详细：再加体感、湿度、风、降水、气压、能见度、AQI。都带数据源与发布时间。 |
| `weather.forecast` | 已开启的时次各一条，详略跟随 `forecastDetail`；逐小时 / 3 小时 / 逐日精度会注明，逐日源会说明按白天/夜间取值。 |
| `weather.alert` | 生效中的预警；等级统一为中央气象台蓝/黄/橙/红四级；没有变化不重复投递。 |
| `weather.next_day` | 每晚推送：明天的天气（逐日源按白天/夜间，逐小时源按当天时次汇总，详略跟随 `forecastDetail`）加当前生效中的预警；需要打开「每晚推送」。 |

四类事件都用 `origin: 'external'` 投递。地名、天气现象、预警标题这些由数据源写的文本会先压平换行、限制长度（预警标题再加「」标出边界），然后按外部事件框定进入对话，不会被当成扩展自己或操作者说的话。因此本包不再声明 `injection-risk`；市场里已经打上的标签需要维护者移除，见下节。

### 工具

- `weather_now`
- `weather_forecast`
- `weather_alerts`

工具优先用 10 分钟内的缓存；请求失败时退回上一次同配置的快照，回执里带原因。数据源没有某项能力时，回执明确说「不提供」，而不是伪造空值。

### 预警归一化

- 中文等级：蓝 / 黄 / 橙 / 红直接识别。
- 和风天气：`severityColor`（Blue/Yellow/Orange/Red）优先，其次 `severity`（Minor/Moderate/Severe/Extreme）。
- Pirate Weather：`minor → 蓝`、`moderate → 黄`、`severe → 橙`、`extreme → 红`。
- 类别：中文灾害名直接匹配（暴雨、大风、寒潮、高温……），英文标题按关键词归类；认不出的保留原标题。
- 无法判断等级时标「未知」，不替数据源升级或降级。

### 标签

`package.json` 的 `cortico.tags` 只声明 `internet`：本包会向互联网请求天气数据。第三方文本的注入风险已经在投递层处理（见「事件」一节），所以不再自我声明 `injection-risk`。

市场索引会沿用维护者此前打过的警示标签，直到他们移除。要摘掉已经显示的「注入风险」，需要向 <https://github.com/Pal-AI-Lab/cortico-extensions> 提一个 issue：

```text
标题：[tags] cortico-world-weather
正文：
package: cortico-world-weather
remove: injection-risk
reason: 0.2.0 起四类天气事件都按 origin:'external' 框定投递，数据源写的文本先压平限长，预警标题再加「」边界，不再符合 injection-risk 的判定条件。
evidence: <修复提交> / <0.2.0 的 npm 页面>
```

## 已知限制

- 中央气象台公开接口没有逐小时预报，1/6/12 小时后的值按目标时刻所属的白天/夜间时段取逐日值。
- 接口盒子的时段预报是 3 小时粒度，1 小时后的值取最近时次；接口盒子和腾讯天气通常只认到地级市，扩展会自动回退，回退时会写明实际查询的地名。
- 自动经纬度按 Open-Meteo 地理编码解析；如果区县名查不到，会退到地级市（例如南宁市武鸣区 → 南宁），因此与区县中心可能有偏差。需要更精确时关闭自动解析并手填经纬度。
- 和风天气 403 常见原因是 API Host 与项目不匹配；配置里新增的「和风天气 · API Host」就是为此准备的。
- Open-Meteo 不提供天气预警。
- 每晚推送只在本机时刻表到点且应用在运行时投递：错过今天这个时刻（应用没开）就等明天同一时刻，不补发。
- 中国气象数据网默认资料是观测，不含未来预报；预警需另购。
- 腾讯天气是公开网页接口，可能临时不可用；预警数组有时为空。
- 和风天气免费订阅有每日调用上限。
- Pirate Weather 免费额度有限，中国本地实况可能不如中央气象台细。

## 开发

```powershell
cd cortico-world-weather
corepack pnpm install
corepack pnpm run build          # 面板产物 dist/webui.js
corepack pnpm exec vitest run    # 87 个用例
corepack pnpm exec tsc --noEmit
corepack pnpm exec tsc -p tsconfig.web.json --noEmit
corepack pnpm run describe       # 重新生成 describe.json
```

契约校验在 Cortico 检出里跑（扩展目录换成你自己的路径）：

```powershell
cd <cortico 检出>/vendor/cortico
corepack pnpm exec tsx scripts/extension-check.ts "<扩展目录>/cortico-world-weather"
```

### 结构

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`：id、默认配置、前置检查、数据源下拉、工具与事件自描述。 |
| `src/config.ts` | `worlds.weather.*` 扁平配置、配置组、开关/详略/时次归一化、文本项首尾空白清理。 |
| `src/credentials.ts` | 凭证解析（配置优先、`.env` 兜底）、激活前检查、注册提示。 |
| `src/world.ts` | 按时次轮询、每晚推送、缓存、事件按外部来源投递/撤回、预警去重、工具、面板数据接口。 |
| `src/providers/` | 七个适配器；`shared.ts` 放名称、预警字段别名、AQI。 |
| `src/forecast.ts` | 1/6/12/24/48 小时与逐日白天/夜间取值。 |
| `src/geocode.ts` | 按省市解析经纬度、24 小时缓存、解析失败提示。 |
| `src/location.ts` | 时区换算、00:00 起算的时次、指定时刻、省市/区县名称展开、数字/缺测值解析。 |
| `src/model-text.ts` | 事件正文（含次日天气）与工具回执：简略/详细两种写法，数据源写的文本压平限长。 |
| `src/webui/client.ts` | 「天气开关」面板：三项开关、两个详略下拉、五个时次开关、每晚推送组、上一次获取。 |
| `src/ENV_PROMPT.md` | 环境提示词。 |
| `tests/` | 87 个用例：时间/时次、七个适配器、正文、World 接线、面板状态、manifest/describe。 |

### 测试与验证状态

- `corepack pnpm exec vitest run` → 87/87 通过。
- 两端 `tsc --noEmit` → 0 错误。
- `corepack pnpm run build` → `dist/webui.js`。
- 扩展契约检查 → `Extension check passed.`
- 真机烟测（公开接口，均用实际地址跑通；具体城市不写进公开文档）：
  - 中央气象台，区县级地址：实况 + 逐日未来 + 当前无预警。
  - 中央气象台，西北某地级市：实况 + 逐日未来 + 一条下辖县的大风蓝色预警，按地市过滤生效。
  - 腾讯天气，区县级地址：区县级没有要素时自动回退到所属地级市，实况 + 逐小时 24h + 逐日 48h 正常。
  - 接口盒子，区县级地址：区县名返回 400 时自动回退地级市，实况 + 3 小时粒度时段预报正常。
  - Open-Meteo，区县级地址：自动解析到该区县所属地级市的经纬度，不再沿用默认城市；逐小时 96h 正常，并明确「不提供天气预警」。
  - 地名带空格（首尾半角空格与全角空格）走中央气象台：清理后实况、逐日未来与次日天气正文均正常。
  - 0.2.0 烟测（逐日源与逐小时源各一家）：简略的实况只留天气与气温；简略的未来天气按时次给天气、气温与降水概率，详细再加降水量与风；只开 6/24 时正文只有这两条；每晚推送的明天天气跟随简略；生效中的预警标题被完整包在「」内并带发布时间。

未验证：

- 真实 Coopanion 端到端（本机未安装应用）。
- 需要密钥的三家（中国气象数据网、和风天气、Pirate Weather）真实账号联调。
- 面板在浏览器里的实际渲染。
