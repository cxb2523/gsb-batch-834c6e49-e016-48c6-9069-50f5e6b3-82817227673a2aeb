# 流式解析：边解析边可播、换源可回收（2026-11-22）

> 验收对象：`web/index.html` 上传页。配套改动见 §1；本地可跑的验收步骤见 §2–§4。

## 0. 一句话结论

`.wrpl` 拖进上传页后，worker 在解出**首批空中单位与时间轴**（约全程 50% 处）就立刻发回一份
可挂载的首批数据，主线程马上 `ACEUI.mount()` 开播；事件/导弹/地形/名称/姿态等仍按原有
分片方式到达并**合并进同一份 mission**（重复挂载不重置机位/倍速/标签/航迹开关/播放位置）。
解析中途失败回滚到上一份完整数据；`done` 后 terminate worker 并释放分片缓冲；
重复拖入时旧 worker / 旧场景资源 / 旧 mission 先释放再挂载，不叠加。

## 1. 改动清单

| 文件 | 改动 |
|---|---|
| `web/wrpl-parse.js` | ① 把相互独立的阶段（结算 BLK / 本机认领 / 时间轴 / y 翻转 / 显示名表）提到 FM 之后、击杀/ECS 之前（产物逐项不变，`check-streaming-parse.mjs` 第 2 组断言）；② `parseMain` 新增 `opts.firstBatch`：首批（meta.window + own + 空中 units）组装后回调；③ `parseInWorker` 流式模式：`{type:'first'}` 的对象即最终 mission 的载体，后续 part 直接合并进它（`mergePartInto`，首个 units 分片**替换**首批临时 units，own 分片合并，terrain/names 占位不覆盖页面字段）；④ `WRPLParse.cancel()`：terminate 在跑的 worker 并以 `code:'cancelled'` 拒绝；⑤ done 后 `store=null` 释放分片缓冲（terminate 原有）；⑥ 顺手修了原有的一处进度回退（ecs 73→72） |
| `web/wrpl-worker.js` | `stream` 时把 `opts.firstBatch` 转成 `{type:'first'}` 消息；透传验收钩子 `debugFailAfterFirstBatch` |
| `mission.js` | `ACEUI.mount(data, {merge:true})`：保留 met 与播放/暂停（机位/倍速/开关本就在模块级保留）；mount 前先 `ACEScene.dispose()` 释放旧场景；新增 `ACEUI.unmount()`（释放场景、清空数据，回到可用的空状态） |
| `three3d/scene.js` | 新增 `dispose()`：几何/材质/纹理 + renderer + OrbitControls 监听 + 标签层 DOM（不 `forceContextLoss`，同一 canvas 的 GL context 要复用） |
| `scene3d3-loader.js` | 代理 API 加 `dispose`；模块版本戳 59→60 |
| `web/index.html` | 流式粘合：`onFirst` 立即挂载并收起上传层（左下浮动进度条继续显示）；`onPart` 350 ms 合帧重挂载（merge）；done 后跑地形/机场目录/型号表 enrichment 并最终挂载；失败回滚 `fallbackMission`（无则 `unmount`）；重复拖入先 `WRPLParse.cancel()`；`?debugfail=1` 验收钩子 |
| `tools/make_demo_wrpl.mjs` | 自造小回放（10 机 / 120 s / 本机属性表；zstd 用合法 raw block，免压缩器），另产 magic 错、结算块垃圾两份坏文件 |
| `tools/check-streaming-parse.mjs` | Node 验收（8 组，见 §2） |
| `web/dev/stream-test.html` + `tools/dev/cdp-run.mjs` | 浏览器集成验收（20 项断言，见 §3） |
| `tools/dev/page-test.mjs` | 真实上传页端到端验收（14 项断言，见 §3） |

## 2. Node 验收（无浏览器）

```bash
node tools/make_demo_wrpl.mjs          # 生成 samples/demo*.wrpl（476 KB × 3）
node tools/check-streaming-parse.mjs   # 8 组断言，末行 "streaming parse ok"
```

覆盖：流式最终产物与非流式**逐项一致**；firstBatch 在 done 前触发且形态可挂载；
进度单调；store 分片合并 == 直出；流式合并（units 替换不重复 / own 分片合并 /
terrain、names 占位不覆盖 / meta 重复合并幂等）；首批后失败钩子；坏文件报错；cancel 空调用。

## 3. 浏览器验收（headless Chrome，需静态服务器）

```bash
node tools/make_demo_wrpl.mjs
node tools/dev/static-server.mjs <仓库根目录>          # 127.0.0.1:8123（见下方注释）
node tools/dev/cdp-run.mjs  http://127.0.0.1:8123/web/dev/stream-test.html 90000
node tools/dev/page-test.mjs http://127.0.0.1:8123
```

- `stream-test.html`（20 项）：首批早于 done、挂载开播、Worker 路径计时、分片合并不叠加、
  姿态发布；**重复挂载幂等**（speed=4 / camera=orbit / 航迹关 / 标签关 / met=30 / 暂停全部保留）；
  场景重挂载不叠加（`ac-labels` 只有 1 层）；cancel；首批后失败；unmount 释放。
- `page-test.mjs`（14 项，驱动真实 `web/index.html` 合成 drop）：上传层在 done 前收起、
  流式进度条出现、地形按地图名加载、坏文件错误态且**旧 mission 不动**、
  `?debugfail=1` 首批后失败**回滚到空状态**、解析中途换文件正常完成。

> 注：按仓库 `.gitignore` 约定，`web/dev/`、`tools/dev/`、`samples/*.wrpl` 不入库
> （与既有「开发期自测页/回放文件不随仓库提供」一致）；`samples/demo*.wrpl` 随时可用
> `node tools/make_demo_wrpl.mjs` 重新生成，三者内容确定（无随机源）。
> 本环境跑 headless Chrome 需要 `--no-sandbox`（cdp-run.mjs / page-test.mjs 已内置）。

## 4. 手动验收（真实回放）

1. `node tools/make_demo_wrpl.mjs`，起任意静态服务器，开 `web/index.html`。
2. 拖入 `samples/demo.wrpl`：进度到「组装目标」前后（约 50%）上传层即收起、场景开播，
   左下小进度条继续到 100%；控制台有 `[stream] 首批已挂载`。
3. 播放中改 4×、切 orbit、按 T/L 关航迹/标签 —— 分片合并与 done 后的重挂载都不重置这些状态。
4. 拖入 `samples/demo-broken-magic.wrpl`：错误态「不支持的回放格式」，场景保持上一局。
5. 开 `web/index.html?debugfail=1` 再拖 `demo.wrpl`：首批挂载后报错，场景回退为空状态。
6. 解析中途再拖一个新文件：旧解析被取消（worker terminate），新文件正常挂载，无叠加。

## 5. 协议（worker → 主线程，新增一条）

```
{ type:'first', data: mission }   首批（时间轴 + 本机 + 空中单位），解出即发；仅 stream 模式
{ type:'part', key, data }        不变；流式时直接合并进 first 的那份对象
{ type:'done' } / { type:'error' } 不变
```

合并语义（`WRPLParse._internal.mergePartInto`，Node 可测）：
`own` 按键合并；`units` 首个正式分片替换首批临时 units 后追加；`__attitude` 按 uid 合并；
流式时 `terrain`/`names` 的占位分片被忽略（归页面按地图名加载）。
