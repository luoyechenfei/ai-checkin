# AI 签到助手（AI-Checkin）

一款 Docker 自部署的**多平台 AI 应用自动签到系统**，内置 Trae、WorkBuddy、CodeBuddy、ZCode、Qoder 五大主流 AI 编程平台适配器，另支持自定义平台接入任意服务，内置 SQLite 存储，无需外部数据库。

## 功能特性

- **多平台签到**：内置 **Trae / WorkBuddy / CodeBuddy / ZCode / Qoder** 五大平台适配器（真实接口配置，参考公开实现），另提供「自定义平台」接入任意平台
- **每日签到 + 活动领取双模式**：Trae / WorkBuddy / CodeBuddy 为每日签到；ZCode / Qoder 为活动领取制（Qoder 每日 10:00 后可领 100 Credits）
- **每日定时签到**：每个账号可单独设置签到时间（默认 08:00），到点自动执行
- **授权保持与自动登出**：平台授权登录后保持 **7 天**，到期自动登出（清除本地凭据）并通过站内通知提醒重新授权
- **多用户注册**：可开关的开放注册，每位用户独立管理自己的平台账号、记录与通知
- **首次初始化向导**：首次访问自动进入初始化页，设置管理员账号密码、站点名称、默认签到时间、时区、端口等
- **端口自定义**：内部端口（容器内监听）与外部端口（宿主机映射）均可自定义
- **响应式 Web**：桌面 / 平板 / 手机自适应
- **深色模式**：支持「跟随系统 / 浅色 / 深色」三态切换，登录后按用户保存偏好，未登录时保存在浏览器本地
- **登录与注册验证码**：图形验证码（4 位、5 分钟有效、一次性使用），防止脚本暴力尝试
- **签到记录管理**：每页默认显示最近 **50 条**，其余通过分页查看；支持单条删除与本页全选批量删除（仅能操作自己的记录）
- **操作日志（审计日志）**：记录登录/注册、账号增删改、手动签到、设置变更、用户与通知管理等操作，**仅管理员**可查看、筛选、删除与清空
- **系统通知与全局公告**：管理员可发布全局通知（普通 / 重要 / 紧急），立即送达全部活跃用户；编辑会同步更新已送达通知，删除会从所有用户通知列表中移除；管理员还可在「系统通知 → 全部通知记录」中逐条或批量删除任意通知（含欢迎通知、授权过期、签到失败等系统消息）
- **权限隔离**：全局设置、用户管理、操作日志、系统通知仅管理员可管理；普通用户仅能管理自己的平台账号与签到记录
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

### 内置平台配置

进入「平台账号」→「添加平台账号」，选择平台类型并填写凭据。各内置平台的接口与字段如下：

| 平台 | 类型 | 认证方式 | 必填字段 | 可选字段 |
|------|------|----------|----------|----------|
| **Trae**（字节） | 每日签到 | `Authorization: Cloud-IDE-JWT {token}` | JWT Token | 设备 ID、用户区域 |
| **WorkBuddy**（腾讯） | 每日签到 | `Authorization: Bearer {access_token}` | Access Token | 用户 ID、域名（可切换 workbuddy.cn / codebuddy.cn） |
| **CodeBuddy**（腾讯） | 每日签到 | `Authorization: Bearer {access_token}` | Access Token | 用户 ID |
| **ZCode**（智谱 Z.ai） | 活动领取 | `Authorization: Bearer {jwt_token}` | JWT Token | 设备 MID、应用版本 |
| **Qoder**（阿里） | 活动领取 | `Authorization: Bearer {token}` | Access Token | Refresh Token |

**Token 获取通用方法**：登录对应平台客户端或网页版 → F12 开发者工具 → Network 面板 → 找任意已登录请求，复制其 `Authorization` 头中的 Token 值。

**Trae Token 获取步骤（已实测验证）**：

1. 浏览器打开 [www.trae.cn](https://www.trae.cn) 并登录（与客户端同一账号）
2. 按 `F12` 打开开发者工具 → 切到 **Network（网络）** 面板，过滤框输入 `api.trae.cn`
3. 按 `F5` 刷新页面，列表会出现 `cn_credits_billing_status` 等请求
4. 点击该请求 → **Headers** → **Request Headers** → 复制 `Authorization: Cloud-IDE-JWT` 后面的整串 Token
5. 填入本系统 Trae 账号的「JWT Token」字段即可

> **注意**：
> - 网页版 Local Storage 里的 `Cloud-IDE-Token` **不可用**（接口返回 code=1001 无法认证），必须从请求头的 `Cloud-IDE-JWT` 取
> - Trae 客户端使用自研网络通道，客户端内 DevTools 的 Network 面板抓不到请求，请用浏览器网页版操作
> - 该会话 Token 有效期约 **12 小时**，失效后按上述步骤重新获取即可；失效时系统会记录失败并通知

**WorkBuddy Access Token 获取步骤（已实测验证）**：

WorkBuddy 是 Electron 桌面应用，Token 加密保存在客户端内存中（磁盘上为密文），只能通过抓包获取：

1. 完全退出 WorkBuddy 客户端（托盘图标也要退出）
2. 命令行带调试端口启动（路径按实际安装位置）：
   ```powershell
   "D:\WorkBuddy\WorkBuddy.exe" --remote-debugging-port=9223
   ```
3. 用 CDP 工具（或浏览器打开 `http://127.0.0.1:9223`）连接调试端口，开启 Network 监听
4. 在客户端内任意操作（或刷新页面），找到发往 `www.workbuddy.cn/v2/...` 的请求
5. 复制请求头 `Authorization: Bearer` 后面的整串 Token 填入本系统
6. 「用户 ID」为 Token 载荷中的 `sub` 字段（UUID），一般可留空

> **注意**：该 Token 为 Keycloak JWT，有效期约 **28 天**，远长于 Trae 的会话 Token，配置一次可稳定使用较久。

**CodeBuddy Access Token 获取步骤**：

CodeBuddy 与 WorkBuddy 同为腾讯系、接口格式一致，优先使用网页版获取：

1. 浏览器打开 [www.codebuddy.cn](https://www.codebuddy.cn) 并登录
2. 按 `F12` 打开开发者工具 → **Network（网络）** 面板，过滤 `/v2/`
3. 按 `F5` 刷新，或进入积分 / 签到页面，点击任意发往 `www.codebuddy.cn/v2/...` 的请求
4. 打开 **Headers → Request Headers**，复制 `Authorization: Bearer` 后面的整串 Token，填入「Access Token」
5. 「用户 ID」为 Token 载荷中的 `sub` 字段，一般可留空

桌面客户端抓包（网页版不可用时）：完全退出 CodeBuddy 后带调试端口启动，再按 WorkBuddy 的方式抓取：

```powershell
# Windows（路径按实际安装位置）
"C:\Program Files\CodeBuddy\CodeBuddy.exe" --remote-debugging-port=9224
# macOS
/Applications/CodeBuddy.app/Contents/MacOS/CodeBuddy --remote-debugging-port=9224
```

浏览器打开 `http://127.0.0.1:9224`，开启 Network 监听，从发往 `www.codebuddy.cn/v2` 的请求头中复制 Token 即可。Token 有效期约 **28 天**。

**ZCode Token 获取步骤**：

1. 登录 ZCode 客户端（`zcode.z.ai`），或用同一账号登录 [z.ai](https://z.ai)
2. 按 `F12` 打开开发者工具 → **Network（网络）** 面板，过滤 `zcode.z.ai`
3. 刷新页面或触发任意套餐 / 计费操作，点击任一发往 `zcode.z.ai` 的请求
4. 打开 **Headers → Request Headers**，复制 `Authorization: Bearer` 后面的整串 JWT，填入「JWT Token」
5. 「设备 MID」可在同一请求头 `X-Device-Mid` 中找到（可不填）；「应用版本」默认 `1.0.0` 即可

> ZCode 为**套餐领取制**而非每日签到：有可领套餐时执行领取；返回 `code=1003`（已领取）或 `code=1005`（名额耗尽）会记录为对应提示。

**Qoder Access Token 获取步骤**：

1. 登录 Qoder CN 客户端，或用同一账号登录 [qoder.com.cn](https://qoder.com.cn)
2. 按 `F12` 打开开发者工具 → **Network（网络）** 面板，过滤 `openapi.qoder.com.cn`
3. 按 `F5` 刷新后点击任意发往 `openapi.qoder.com.cn` 的请求
4. 打开 **Headers → Request Headers**，复制 `Authorization: Bearer` 后面的整串 Token，填入「Access Token」
5. 「Refresh Token」可留空；Token 失效时接口返回 401，系统会自动标记授权失效并提示重新授权

> Qoder 服务端每日 **10:00（UTC+8）** 后才刷新当日额度，请把该账号的签到时间设置在 10:00 之后。

> 以上 ZCode / Qoder 的接口地址、请求头与响应判定均已按现有适配器实现核对；由于各平台接口可能随版本调整，若签到失败可抓包后用「签到接口地址」覆盖默认值，或改用「自定义平台」接入。

### 各平台说明

- **Trae**：调用 `api.trae.cn` 签到接口；若返回「本设备今日已有账号签到」（code=9095）说明当日已签
- **WorkBuddy / CodeBuddy**：同一套接口格式，域名不同；WorkBuddy 账号可通过「域名」字段切换到 codebuddy.cn 域名；返回「已签到」（code=10001）视为成功，code=41000 表示活动未开始
- **ZCode**：非每日签到，而是**套餐领取制**，有可领套餐时执行领取；已领完（code=1003）或名额耗尽（code=1005）会记录为对应提示
- **Qoder**：**每日领取 100 Credits**，服务端每日 **10:00（UTC+8）** 刷新额度；系统采用两步流程：先获取活动列表，再对当日未领取的活动执行领取；建议将签到时间设置在 10:00 之后

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
| 签到记录 | 每页 50 条，支持按平台、结果筛选，单条删除与本页批量删除（仅本人记录） |
| 通知 | 授权到期、签到失败、系统公告等提醒，支持一键已读 |
| 管理 → 全局设置与用户（仅管理员） | 站点设置、注册开关、用户管理（禁用/启用/删除/重置密码）、全部账号概览 |
| 管理 → 操作日志（仅管理员） | 审计日志查询（按用户/详情/IP/操作类型）、单条删除、批量删除、清空 |
| 管理 → 系统通知（仅管理员） | 发布全局通知（普通/重要/紧急）、编辑、删除；「全部通知记录」支持逐条或批量删除任意通知（含欢迎通知等系统消息） |

## 深色模式与验证码

**深色模式**：右上角「主题模式」下拉框提供「跟随系统 / 浅色 / 深色」三态。

- 登录后选择会写入用户偏好，换设备 / 重新登录后保持一致
- 未登录（登录、注册、初始化页）时选择保存在浏览器 `localStorage`
- 选择「跟随系统」时，页面会实时响应操作系统深浅色切换
- 样式表引用带版本号并采用协商缓存，升级后会自动加载新样式；若页面仍显示旧样式，强制刷新一次即可

**验证码**：登录与注册均需输入图形验证码。

- 4 位大写字母/数字，5 分钟有效，**验证一次即失效**（失败也需刷新重取）
- 点击验证码图片可刷新
- 验证码在服务端内存中生成与校验，不落库；容器重启后需重新获取（无影响）

## 权限模型

| 能力 | 管理员 | 普通用户 |
|------|--------|----------|
| 自己的平台账号 / 签到记录 | ✅ | ✅ |
| 删除自己的签到记录（单条 / 批量） | ✅ | ✅ |
| 查看与管理自己的通知 | ✅ | ✅ |
| 全局设置 / 用户管理 | ✅ | ❌ |
| 操作日志查看 / 删除 / 清空 | ✅ | ❌ |
| 系统通知发布 / 编辑 / 删除 | ✅ | ❌ |
| 删除任意通知记录（含欢迎通知等系统消息） | ✅ | ❌ |

> 前端隐藏入口仅为体验优化，所有管理接口在服务端均有 `requireAdmin` 校验，越权请求返回 403。

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
    ├── db.js              # SQLite 初始化与 schema（含操作日志、全局通知表）
    ├── security.js        # scrypt 密码哈希、会话管理、权限中间件
    ├── captcha.js         # 图形验证码生成与校验（内存存储）
    ├── scheduler.js       # 定时调度（每日签到 / 授权到期登出）
    ├── platforms.js       # 平台适配器与签到引擎
    ├── routes/            # 页面与动作路由
    ├── views/             # EJS 模板（响应式）
    └── public/style.css
```

## 常见问题

**Q: 签到显示失败？**
检查 Token / Cookie 是否正确、是否已过期（平台返回 401/403 会自动登出并通知）；平台接口是否变更（可抓包后通过「签到接口地址」覆盖）；查看「签到记录」中的失败消息。

**Q: Qoder 为什么早上签到失败？**
Qoder 服务端每日 10:00（UTC+8）才刷新当日额度，请将该账号的签到时间设置在 10:00 之后。

**Q: ZCode 提示「已领取过 / 名额已领完」？**
ZCode 是活动领取制而非每日签到，属正常返回，对应活动状态会记录在签到日志中。

**Q: 如何修改端口？**
重建容器时指定 `-p 外部:内部` 与 `-e INTERNAL_PORT=内部`；后台「全局设置」中的端口为记录展示用途。

**Q: 忘记管理员密码？**
删除 `data/checkin.db` 后重新初始化（会清空全部数据）；或由其他管理员账号重置。

## 免责声明

本项目仅用于个人学习与自动化效率工具，请遵守目标平台的服务条款，由此产生的账号风险由使用者自行承担。
