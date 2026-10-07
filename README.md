# 陨石样本编目台（sologsb-1125 / gbmeteorite）

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21825>

停止（镜像保留）：

```bash
docker compose down
```

## 项目简介

面向陨石收藏者与标本室的纯前端单页应用：把样本、发现记录、切片制样与检测数值整理成本地可检索档案。
核心动作是登记样本与发现地坐标、挂接切片、录入电子探针数值并给出分类建议。

- 纯前端 SPA：**无后端、无数据库服务、无外部 API**
- 所有数据保存在浏览器本地：业务数据走 **IndexedDB（Dexie，库名 `gbmeteorite-db`）**，表单草稿走 **localStorage**
- 容器无状态，不挂载任何命名卷；换浏览器即换档案库
- **多窗口协同编目**：两个窗口同时录同一批样本时——
  - 一个窗口写入后，另一个窗口的样本总览 / 详情 / 切片库 / 分析检测 / 发现地分布自动跟随刷新，各页统计（数量、重量、地区聚合）即时重算（`BroadcastChannel`，localStorage 兜底）
  - 样本编号 / 切片编号为数据库**唯一索引**，两边绝不会撞号；编号建议直接查库生成（`MET-年份-序号`），另一窗口刚占用的序号立即可见
  - 样本与切片更新带 `updatedAt` **乐观锁**：数据落后的窗口再保存时会先收到「已被另一窗口修改」提示并自动刷新到最新，**不会覆盖对方结果**
  - 写入失败（编号冲突 / 乐观锁落后 / 存储异常）一律**保留本地草稿**，关掉重开仍可恢复接着录；只有真正写入成功才清草稿

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript 5.7 |
| 构建 | Vite 6（`build` 脚本为 `tsc -b && vite build`，类型检查零错误） |
| UI 组件库 | MUI（@mui/material 6 + @mui/icons-material） |
| 状态管理 | Zustand（`sampleStore` 业务数据 / `uiStore` 筛选与提示） |
| 路由 | React Router 6（BrowserRouter + nginx `try_files` 兜底） |
| 本地存储 | Dexie 4（IndexedDB）+ localStorage（草稿） |
| 部署 | 多阶段 Dockerfile：node:20-alpine 构建 → nginx:alpine 托管 |

## 核心页面

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 样本总览：卡片流 + 分类/化学群/重量区间筛选与排序，缺坐标或缺切片显示角标 | MeteoriteSample |
| `/samples/new` | 样本登记：编号生成、分类化学群、重量、存放位置，可补录发现地坐标并即时校验 | MeteoriteSample、FindRecord |
| `/samples/:id` | 样本详情：基本信息 + 发现地摘要 + 切片列表 + 分析记录，可就地新增 | 四个模型 |
| `/sections` | 切片库：按厚度与矿物占比筛选，回跳样本，批量标注质量 | ThinSection、MeteoriteSample |
| `/analysis` | 分析检测：录入 Fa / Fs / Ni / 铁纹石带宽，实时分类建议与阈值命中说明 | AnalysisRecord、MeteoriteSample |
| `/locations` | 发现地分布：SVG 网格按经纬度打点、按分类着色、点选弹出样本清单 | FindRecord、MeteoriteSample |

## 数据模型（`src/types/` 独立文件）

- `types/sample.ts` — **MeteoriteSample**：id、样本编号、总重量 g、分类、化学群、风化等级 W0–W4、发现/坠落、存放位置
- `types/find.ts` — **FindRecord**：id、关联样本、地名、国家地区、经纬度、坐标来源（GPS/文献）、发现环境、发现者
- `types/section.ts` — **ThinSection**：id、切片编号、关联样本、厚度 μm、制样方式、矿物占比、显微照片清单
- `types/analysis.ts` — **AnalysisRecord**：id、关联样本或切片、方法、橄榄石 Fa、辉石 Fs、Ni wt%、铁纹石带宽 mm、检测日期

## 目录结构

```
sologsb-1125/
├── docker-compose.yml
├── .env / .env.example
├── README.md
└── frontend/
    ├── Dockerfile          # 多阶段：node:20-alpine → nginx:alpine
    ├── nginx.conf          # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig*.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/{sample,find,section,analysis}.ts
        ├── db/
        │   ├── index.ts                # Dexie 封装与 v1→v5 升级迁移、权威编号生成
        │   ├── sync.ts                 # 跨窗口变更广播（BroadcastChannel + storage 兜底）
        │   └── errors.ts               # StaleWriteError / UniqueConflictError
        ├── stores/{sampleStore,uiStore}.ts
        ├── components/common/{SampleCard,Badge,FieldGroup,EmptyState,CoordinatePicker,AppShell}.tsx
        ├── hooks/{useSampleFilter,useLocalDraft,useRegionStats,useCrossTabSync}.ts
        ├── pages/{Overview,New,Detail,Sections,Analysis,Locations}.tsx
        ├── router/index.tsx
        └── utils/{classify,format,geo}.ts
```

## 数据存储说明

- **库名**：`gbmeteorite-db`；表：`samples`、`finds`、`sections`、`analysis`
- **版本迁移**：
  - v1 建 `samples` / `finds` / `sections`
  - v2 新增 `analysis` 表并加 `sampleId` 索引
  - v3 为 `samples` 补 `updatedAt` 字段并按 id 回填旧记录
  - v4 为 `finds` / `sections` / `analysis` 补 `updatedAt`（乐观锁版本字段），并把历史重号样本/切片逐条改号（追加 `-dupN` 后缀）
  - v5 将 `samples.sampleNo` 与 `sections.sectionNo` 升为唯一索引（去重在 v4 已完成，建唯一索引不会失败）
- **草稿**：`/samples/new`、`/analysis` 与样本详情页就地新增切片 / 检测的表单草稿写入 localStorage（键前缀 `gbmeteorite:draft:`），切页 / 关窗自动恢复，**仅写入成功后清理**；写入失败原样保留
- **跨窗口通知**：写操作提交后经 `BroadcastChannel`（通道 `gbmeteorite-db-changes`；不支持时回落 localStorage storage 事件，再以窗口聚焦补拉兜底）通知其他窗口静默重拉
- 首次打开会灌入 3 份演示样本、2 条发现记录、2 张切片与 2 条检测记录，便于直接体验筛选与打点；两窗口首次同时打开撞车灌库时以唯一索引为准，落败方静默放弃

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `gbmeteorite` | Compose 项目名与容器名前缀 |
| `FRONTEND_PORT` | `21825` | 宿主端口，映射到容器 80 |
