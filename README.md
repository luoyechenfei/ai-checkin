# AI 签到助手（AI-Checkin）

一款 Docker 自部署的**多平台 AI 应用自动签到系统**，支持 Trae、WorkBuddy、CodeBuddy 等常用 AI 平台，内置 SQLite 存储，无需外部数据库。

## 功能特性

- **多平台签到**：内置 Trae / WorkBuddy / CodeBuddy 适配器，另提供「自定义平台」接入任意平台
- **每日定时签到**：每个账号可单独设置签到时间（默认 08:00），到点自动执行
- **授权保持与自动登出**：平台授权登录后保持 **7 天**，到期自动登出（清除本地凭据）并通过站内通知提醒重新授权
- **多用户注册**：可开关的开放注册，每位用户独立管理自己的平台账号、记录与通知
- **首次初始化向导**：首次访问自动进入初始化页，设置管理员账号密码、站点名称、默认签到时间、时区、端口等
- **端口自定义**：内部端口（容器内监听）与外部端口（宿主机映射）均可自定义
- **响应式 Web**：桌面 / 平板 / 手机自适应
- **签到记录与通知**：全部签到结果留痕，失败自动通知，支持按平台 / 结果筛选
- **积分统计**：自动识别签到响应中的积分（`points` / `credit` / `reward` / `integral` 等字段），记录每次获得积分并汇总今日 / 累计积分；自定义平台可指定「积分字段路径」精确取值

## 积分识别说明

签到成功后，系统解析响应 JSON 并提取积分，写入签到记录（`logs.points`）：

1. 若账号填写了「积分字段路径」（仅自定义平台提供），按点分路径精确取值，如 `data.reward.points`
2. 否则自动识别常见字段名（不区分大小写，最多 5 层嵌套）：`points`、`credit`、`reward`、`integral`、`score`、`coin`、`balance` 等
3. 无法识别或平台不返回积分时记为 0，签到本身不受影响

仪表盘展示「今日积分 / 累计积分」，签到记录页逐条展示，平台账号卡片展示各账号累计积分。

## 快速开始（Docker Compose，推荐）

```bash
cd ai-checkin
docker compose up -d
```

访问 `http://服务器IP:3000`，首次访问会进入初始化向导。

### 自定义端口启动

```bash
# 外部端口 8080，内部端口 3000（也可两者都改）
EXTERNAL_PORT=8080 INTERNAL_PORT=3000 docker compose up -d
```

或直接使用 `docker run`：

```bash
docker build -t ai-checkin .
docker run -d \
  --name ai-checkin \
  -p 8080:3000 \
  -e INTERNAL_PORT=3000 \
  -e TZ=Asia/Shanghai \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  ai-checkin
```

> 国内构建加速：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`

### 使用已发布的镜像（GitHub Container Registry）

推送到 `main` 分支或打 `v*` 标签后，GitHub Actions 会自动构建 `linux/amd64` 与 `linux/arm64` 双架构镜像并发布到 GHCR：

```bash
# 镜像地址：ghcr.io/<你的GitHub用户名或组织>/ai-checkin:latest
docker pull ghcr.io/<owner>/ai-checkin:latest

docker run -d \
  --name ai-checkin \
  -p 8080:3000 \
  -e INTERNAL_PORT=3000 \
  -e TZ=Asia/Shanghai \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  ghcr.io/<owner>/ai-checkin:latest
```

也可以在 `docker-compose.yml` 中把 `build:` 换成 `image:` 直接使用已发布镜像：

```yaml
services:
  ai-checkin:
    image: ghcr.io/<owner>/ai-checkin:latest
```

> 首次发布后，需在 GitHub 仓库的 **Packages** 页面把镜像可见性设为 `Public`（默认是 Private，需 `docker login ghcr.io` 才能拉取）。

## 初始化向导

首次访问 `/setup`，依次设置：

1. 站点名称
2. 管理员用户名 / 密码（密码至少 6 位）
3. 默认每日签到时间、时区（IANA 格式，如 `Asia/Shanghai`）
4. 内部端口 / 外部端口（记录用途，需与 Docker 端口映射一致）
5. 是否开放用户注册

## 平台授权与签到

### 授权方式

进入「平台账号」→「添加平台账号」，选择平台类型并填写凭据：

| 字段 | 获取方式 |
|------|----------|
| Cookie | 浏览器登录目标平台 → F12 开发者工具 → Network 面板 → 任选请求复制 `Cookie` 请求头 |
| API Token | 部分平台需要，按平台实际情况填写 |
| 签到接口地址 | 可选。留空使用内置默认；官方接口变动时可在此覆盖 |

### 自定义平台

选择「自定义平台」可接入任意平台：

- **签到接口地址 / 请求方法**：必填
- **Cookie / 额外请求头（JSON）/ 请求体**：按需填写
- **成功关键字**：响应内容包含该关键字才视为签到成功，留空则 HTTP 2xx 即视为成功

> **说明**：各平台签到接口可能随官方版本调整，内置适配器的默认接口地址仅供参考，建议使用「签到接口地址」字段覆盖为实际抓包到的接口，或直接使用「自定义平台」接入。

### 授权保持策略

- 添加账号（或重新授权）后授权期为 **7 天**
- 到期后系统自动登出：清除本地保存的凭据，账号标记为「已过期」，并发送站内通知
- 点击「重新授权」重新填写凭据即可刷新授权期
- 若签到时平台返回 401/403（授权失效），同样会自动登出并通知

## 页面说明

| 页面 | 说明 |
|------|------|
| 仪表盘 | 账号统计、今日签到安排、最近签到记录 |
| 平台账号 | 添加 / 立即签到 / 重新授权 / 修改签到时间 / 暂停 / 删除 |
| 签到记录 | 最近 200 条，支持按平台、结果筛选 |
| 通知 | 授权到期、签到失败等提醒，支持一键已读 |
| 管理（仅管理员） | 全局设置、用户管理（禁用/启用/删除/重置密码）、全部账号概览 |

## 配置参考

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `INTERNAL_PORT` | `3000` | 容器内监听端口 |
| `EXTERNAL_PORT` | `3000` | 宿主机映射端口（docker-compose 使用） |
| `TZ` | `Asia/Shanghai` | 容器系统时区 |
| `DATA_DIR` | `/app/data` | 数据目录（SQLite 文件所在） |
| `NPM_REGISTRY` | npmjs 官方 | 构建时 npm 镜像源 |

### 数据持久化

SQLite 数据库文件位于容器的 `/app/data/checkin.db`，通过卷挂载 `./data:/app/data` 持久化。备份时直接复制 `data` 目录即可。

> **安全提示**：数据库中保存了各平台的登录凭据（Cookie/Token），请妥善保护服务器与 `data` 目录，不要泄露给他人。

## 本地开发（非 Docker）

要求 Node.js ≥ 22.5（使用内置 `node:sqlite`，无原生编译依赖）：

```bash
npm install
npm start          # 默认监听 3000，可用 INTERNAL_PORT=xxxx npm start 修改
```

## 项目结构

```
ai-checkin/
├── Dockerfile / docker-compose.yml
├── package.json
├── data/                  # SQLite 数据（运行时生成）
└── app/
    ├── server.js          # 入口
    ├── config.js          # 配置
    ├── db.js              # SQLite 初始化与 schema
    ├── security.js        # scrypt 密码哈希、会话管理
    ├── scheduler.js       # 定时调度（每日签到 / 授权到期登出）
    ├── platforms.js       # 平台适配器与签到引擎
    ├── routes/            # 页面与动作路由
    ├── views/             # EJS 模板（响应式）
    └── public/style.css
```

## 常见问题

**Q: 签到显示失败？**
检查 Cookie 是否正确、是否已过期；平台接口是否变更（可抓包后通过「签到接口地址」覆盖）；查看「签到记录」中的失败消息。

**Q: 如何修改端口？**
重建容器时指定 `-p 外部:内部` 与 `-e INTERNAL_PORT=内部`；后台「全局设置」中的端口为记录展示用途。

**Q: 忘记管理员密码？**
删除 `data/checkin.db` 后重新初始化（会清空全部数据）；或由其他管理员账号重置。

## 免责声明

本项目仅用于个人学习与自动化效率工具，请遵守目标平台的服务条款，由此产生的账号风险由使用者自行承担。
