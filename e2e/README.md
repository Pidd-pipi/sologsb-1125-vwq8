# 跨窗口并发与迁移验证

本目录是不进生产镜像的端到端验证脚本，用于确认标本室两人 / 两窗口同时编目的行为。

## crosstab.cjs — 两窗口协同（Playwright，真实 Chromium）

同一浏览器 context 开两个页面（共享 IndexedDB / localStorage / BroadcastChannel），覆盖：

1. A 窗口登记样本后，B 窗口样本总览、顶栏计数、发现地分布与统计自动更新
2. 样本编号唯一约束：另一窗口抢用同号时保存被拒、不覆盖对方、给出下一个可用编号
3. 撞号 / 校验 / 异常时草稿保留在 localStorage，按建议改号后可保存成功
4. 切片批量标注乐观锁：版本落后的提交被跳过并提示，库里保留另一边的最新结果
5. 样本详情「切换存放状态」乐观锁：提示「内容已落后」并自动刷新到对方版本
6. 刷新 / 重开窗口后草稿恢复接着录
7. 检测记录跨窗口同步到分析检测列表
8. 切片新增跨窗口同步到样本详情计数
9. 模拟 IndexedDB 写入失败：提示失败、不跳转、草稿保留，恢复后重试成功

运行（先 `npm run build && npm run preview`，并安装 `npx playwright install chromium`）：

```bash
NODE_PATH=../frontend/node_modules node crosstab.cjs
```

## migration.ts — IndexedDB v3→v4→v5 升级（fake-indexeddb）

先按 v3 schema 造含重号、缺 `updatedAt` 的旧库，再加载真实 `MeteoriteDB`，验证：

- 历史重号样本 / 切片自动追加 `-dupN` 后缀去重，较早记录保留原号
- finds / sections / analysis 回填 `updatedAt`，samples 的 v3 版本号不变
- v5 唯一索引建立后，重复 `sampleNo` 的写入被 `ConstraintError` 拒绝

运行（esbuild 即时打包 TS）：

```bash
NODE_PATH=../frontend/node_modules ../frontend/node_modules/.bin/esbuild \
  migration.ts --bundle --platform=node --format=cjs --outfile=/tmp/migration.cjs
node /tmp/migration.cjs
```
