# Imagine · 图片创作工作台

一个受 Grok Imagine 图片工作流启发的独立 Web 应用。React + TypeScript 前端，Node.js + Express 后端。支持自己的 xAI / OpenAI 兼容服务和部署在 Hugging Face Spaces 上的 Gradio 模型。

## 运行

需要 Node.js 22.13+。

```bash
npm ci
cp .env.example .env
npm run dev
```

打开 **http://127.0.0.1:5173**。开发模式同时运行 Vite（5173）和 API（3001）；Vite 自动代理 API 和图片请求。开发模式后端端口应保持 3001。

生产运行：

```bash
npm run check
npm test
npm run build
npm start
```

打开 **http://127.0.0.1:3001**。

## 已实现

- 文生图、上传图片后用提示词编辑、多轮编辑已有作品。
- 图片比例、1–4 张批量生成；Gradio 支持可映射的种子、反向提示词、步数、引导系数。
- 多提供商的创建、编辑、停用、删除与连接测试。
- Hugging Face Space API 探测、生成和编辑分别配置端点、JSON 参数模板和输出路径。
- 服务端任务队列（同时 2 个，最多排队 10 个）、状态刷新、失败原因和取消任务。
- 作品库、下载原图、收藏、删除、复用提示词、生成历史。
- 服务端保存图片和缩略图，重启后保留数据；不依赖上游临时图片链接。
- AES-256-GCM 加密保存 Key；访问令牌登录和 HttpOnly 会话 Cookie。
- 桌面与移动布局、键盘快捷键、可访问的弹窗。

这是图片生成与编辑版本，不包含 Grok 的私有推荐流、视频、聊天、账号或计费系统；生成速度、画质、审核、编辑能力和费用由模型提供商决定。首页「灵感广场」是明确标记的摄影参考，实际生成的图片进入「我的作品」。

## 配置 xAI

进入「提供商设置」，选择 xAI，填写 Key、API 根地址（默认 `https://api.x.ai/v1`）和实际可用的模型 ID。默认示例 `grok-imagine-image-2.0`，可按账户权限修改。

生成使用 `POST /images/generations` 和 `aspect_ratio`；编辑使用 `POST /images/edits`，以 **JSON** 发送 `image: {url: "data:image/png;base64,...", type: "image_url"}`。

## 配置 OpenAI / 兼容服务

选择「OpenAI 兼容」，填写 Base URL（包含 `/v1`）、模型 ID 和 Key。示例模型 ID 不保证账户具备权限，请以提供商为准。

生成调用 `/images/generations`，编辑通过 multipart/form-data 调用 `/images/edits`，含图片和可选蒙版。支持 `data[].url` 和 `data[].b64_json` 响应。

OpenAI 模式提供标准的 1024×1024、1536×1024、1024×1536 尺寸，对应 1:1、3:2、2:3。老模型或第三方服务可能支持不同的尺寸或批量上限；上游不支持时会显示具体错误。扩展请求参数可设置 `quality`、`response_format` 等字段。生成模型、提示词、张数和尺寸始终以工作台设置为准。`negative_prompt`、种子、步数和引导系数仅用于 Gradio 映射，不会发送给 OpenAI / xAI。

「保存并测试」读取 `/models`，不会产生付费图片；部分兼容服务不提供模型列表，此时测试失败并不一定表示图片接口不可用。编辑模型必须主动启用编辑能力。

## 接入 Hugging Face Spaces

1. 在「提供商设置」选择「HF Spaces」。
2. 填写 Space URL，例如 `https://huggingface.co/spaces/Qwen/Qwen-Image-Edit`。也接受 `owner/space-name` 和 `https://xxx.hf.space`。
3. 私有 Space 填写有访问权限的 HF Token；公开 Space 可以先留空，但 ZeroGPU 等资源可能要求 Token。
4. 点击「自动读取并填写」，或直接点击「保存连接」（尚未识别时会先自动读取）。
5. 检查识别结果后保存。自动填入名称、生成/编辑端点、参数映射、各自的图片输出路径，以及模型默认步数和引导系数。仅支持编辑的 Space 会在工作台切换到编辑模式。

系统读取 Gradio API 定义，不会为了探测配置调用图片生成。默认通过 API 结构识别，无需额外 AI 服务或 Key。未知必填项、多张必需参考图、特殊 OAuth 授权等无法可靠自动完成时，会提示需要补充配置；可展开「高级配置」检查，或点击「手动配置」编辑 JSON。

**可选 AI 辅助**：在服务端 `.env` 配置一个支持 Chat Completions 和 JSON 输出的文本模型：

```dotenv
CONFIG_AI_BASE_URL=https://your-ai-provider.example/v1
CONFIG_AI_MODEL=your-text-model
CONFIG_AI_API_KEY=your-ai-key
```

重启后，自动配置会使用该模型辅助理解非标准参数名，并校验返回的端点、参数、占位符和固定值。AI 不可用或校验失败时回退到 API 结构识别。启用后会把 Space 的 API 定义发送给这个 AI 提供商，可能产生文本模型调用费用；不会发送 HF Token、工作区 API Key、上传图片或生成任务内容。示例中的文本模型独立于图片提供商，不能填写图片模型 ID。

**手动配置参考**：

以下示例只适用于恰好使用这些参数名的端点：

```json
{
  "prompt": "{{prompt}}",
  "seed": "{{seed}}",
  "randomize_seed": false,
  "width": "{{width}}",
  "height": "{{height}}",
  "num_inference_steps": "{{steps}}",
  "guidance_scale": "{{guidance}}"
}
```

编辑参数示例：

```json
{
  "image": "{{image}}",
  "prompt": "{{prompt}}",
  "seed": "{{seed}}"
}
```

支持位置参数数组，例如 `["{{prompt}}", "{{seed}}", false]`，也支持嵌套 JSON。`"{{seed}}"` 这类完整占位符会保留数字或文件对象类型。

| 占位符 | 含义 |
| --- | --- |
| `{{prompt}}` | 正向提示词 |
| `{{negative_prompt}}` | 反向提示词 |
| `{{image}}` | 原图，通过 Gradio `handle_file` 上传 |
| `{{images_b64_json}}` | 包含一张参考图 Data URI 的 JSON 字符串，适用于同名自定义输入 |
| `{{image_base64}}` / `{{image_data_uri}}` | 原图的纯 Base64 / Data URI 字符串 |
| `{{mask}}` | 可选蒙版文件，无蒙版时为 null |
| `{{width}}` / `{{height}}` | 比例对应像素尺寸 |
| `{{seed}}` | 生成种子，批量时每张加 1 |
| `{{steps}}` / `{{guidance}}` | 步数与引导系数 |
| `{{aspect_ratio}}` | 画面比例，例如 1:1 |

Gradio ImageEditor 参数可能需要 `{"background":"{{image}}","layers":[],"composite":"{{image}}"}`，以组件 API 为准。蒙版需为与原图同尺寸的 PNG；OpenAI 通常以透明区域作为编辑区域，具体语义由模型决定。

**生成与编辑输出路径**分别自动识别，也可手动修改。默认 `0`，表示 `result.data[0]`；Gallery 可用 `0`，更深层可用 `0.0.image`；留空遍历全部输出。支持 URL、FileData、Gallery、base64 图片。FileData 中只有远端文件路径时，会通过连接的 Space 的文件 API 转换为下载 URL，不会读取本应用所在机器的同名路径。

部分 Qwen Edit 自定义界面用 `images_b64_json` 文本字段传图片，而不是 Gradio Image 组件。这类端点会识别为图片编辑，并自动映射 `"images_b64_json": "{{images_b64_json}}"`；必须先上传参考图，不能使用空数组 `"[]"` 进行文生图。旧版本误存成文生图且图片列表为空的编辑 Space，重启服务时会自动修正，保留 Token、LoRA 等自定义选项。

如果仍没有图片，错误会显示端点、读取路径和返回结构的类型摘要；Gradio 的错误状态会显示原始失败原因，避免把 GPU 配额、输入错误等误报为输出路径问题。支持标准 Image / Gallery / FileData，以及 `image`、`images`、`result` 等字典字段或 JSON 字符串中的图片。

每个 Gradio 请求取一张结果；生成多张时逐次调用，种子依次递增。Space 的休眠、GPU 排队、访问权限、ZeroGPU 限额或上游异常会影响调用。任务超过 10 分钟超时；取消会尝试取消 Gradio 队列，已开始的推理与计费是否停止由提供商决定。

当前支持 **Gradio API** 的 Spaces，不自动兼容任意 Streamlit / Docker HTTP 接口；Docker Space 可运行 Gradio 服务后接入。不支持 Space 额外设置的用户名/密码登录。

## 数据与部署

默认单用户实例。**同一实例的全部配置、作品与任务对登录用户共享**，不是多租户产品。

- 配置、任务历史与图片元数据：SQLite 数据库 `data/workspace.sqlite`。首次启动会自动导入旧 `workspace.json`，保留旧文件作为迁移前备份，之后以 SQLite 为准。
- 原图与缩略图：`data/media/`。
- 本地加密密钥：`data/.encryption-key`（启动时生成，权限 0600）；也可通过 `ENCRYPTION_KEY` 指定 base64 格式的 32 字节密钥。
- 备份整个 `data/`，包括加密密钥；改变或丢失密钥将无法解密已保存的 API Key。密钥与数据默认位于同一机器，加密不能防御整机泄露。
- `.env`、`data/` 均不应提交到版本库。
- 默认监听 127.0.0.1，不要求登录。非本地监听必须配置 `ADMIN_TOKEN`；也可在本地启用此令牌。
- 对外部署用 HTTPS 反向代理，并保留浏览器 Host。生产端口由 `PORT` 配置；上传限制应允许 20MB 请求体，推理请求由异步任务处理。
- API 请求和图片下载直接使用 Node 默认网络机制，跟随运行环境的 DNS 和代理行为；不自行解析 DNS，不按公网或内网地址拦截。
- 使用 SQLite 事务与 WAL 日志持久化，适合个人自托管；任务调度仍为单进程，不支持多个服务实例同时共享同一数据目录。备份时请停止服务后复制整个 `data/`，包含数据库、WAL 文件与密钥。服务重启后未完成的任务标记为失败，可以重新提交。

### Docker 部署

镜像将前端静态文件与 Node 后端一起打包，对外使用一个 HTTP 端口。构建过程中会执行类型检查、测试与前端生产构建，最终镜像以非 root 的 `node` 用户运行，并内置健康检查。

首次部署到新目录时，可把 `.env.docker.example` 复制为 `.env`，填写 `ADMIN_TOKEN`。已有 `.env` 请保留原内容，补充所需变量。Token 是网页的登录口令，不要使用图片提供商的 API Key。

```bash
docker compose up -d --build
```

默认访问 **http://127.0.0.1:3001**，输入 `ADMIN_TOKEN` 登录。镜像标签为 `grokimage:latest`。可在 `.env` 中配置：

```dotenv
ADMIN_TOKEN=your-long-random-workspace-token
PUBLISH_HOST=127.0.0.1
PUBLISH_PORT=3001
```

需要直接从其他机器访问时，将 `PUBLISH_HOST` 设置为 `0.0.0.0`，然后访问 `http://服务器IP:3001`；已有反向代理时可保留默认的本地绑定。修改宿主机端口使用 `PUBLISH_PORT`，容器内部仍使用 3001。

常用命令：

```bash
docker compose logs -f --tail=100
docker compose ps
docker compose down
docker compose up -d --build
```

`docker compose down` 保留数据卷；`docker compose down -v` 会删除作品、提供商配置和加密密钥，不用于普通升级。

数据保存到命名卷 `imagine-data` 对应的 `/app/data`。镜像不包含本机 `.env`、`data/`、API Key 或作品。`CONFIG_AI_BASE_URL`、`CONFIG_AI_MODEL`、`CONFIG_AI_API_KEY` 可选；`ENCRYPTION_KEY` 留空时会在数据卷内生成密钥，若显式设置则后续部署需保持一致。

**迁移当前本地工作区**：Docker 默认使用独立数据卷，不会自动读取源码旁的 `data/`。先停止原来的本地 Node 服务，再在项目目录执行以下操作，将本地数据复制进一个新的或已备份的 Docker 数据卷：

```bash
docker compose create
docker compose stop
docker compose cp ./data/. imagine:/app/data/
docker compose run --rm --no-deps --user root --entrypoint chown imagine -R node:node /app/data
docker compose up -d
```

复制整个目录以包含 `.encryption-key`；如果原服务使用环境变量 `ENCRYPTION_KEY`，Docker 的 `.env` 也需使用同一值。迁移会覆盖卷中同名文件，应只向新卷或已备份的卷执行。

也可直接构建和运行镜像：

```bash
docker build -t grokimage:latest .
docker run -d --name grokimage \
  -p 127.0.0.1:3001:3001 \
  -e ADMIN_TOKEN=your-long-random-workspace-token \
  -v grokimage-data:/app/data \
  --restart unless-stopped \
  grokimage:latest
```

迁移到不便构建镜像的机器，可先 `docker save -o grokimage.tar grokimage:latest`，再在目标机器 `docker load -i grokimage.tar`；镜像架构应与目标机器匹配。

### GitHub 自动构建镜像

仓库的 `.github/workflows/docker.yml` 会在推送 `main`、推送 `v*` 标签或手动运行时构建并发布镜像到 **`ghcr.io/coinlet/huggingimage`**，支持 `linux/amd64` 和 `linux/arm64`。PR 仅构建 AMD64 验证，不登录镜像仓库、不发布镜像。构建继续执行 Dockerfile 内的类型检查、单元测试和前端构建，并使用 GitHub Actions 缓存。

- `latest`：跟随 `main`；手动构建其他分支或发布旧版本标签不会覆盖它。
- `v1.2.3` 标签：发布 `v1.2.3`、`1.2.3`、`1.2` 等版本标签；预发布版本保留完整版本号。
- `sha-<完整提交 SHA>`：对应具体提交，便于固定版本和回退。

工作流使用 GitHub 自动提供的 `GITHUB_TOKEN` 与 `packages: write` 权限，无需额外配置 Docker Hub 密钥。首次运行可在仓库 **Actions → Docker image** 查看进度，或点击 **Run workflow** 手动构建。若仓库或组织禁止 Actions 写入 Packages，需由仓库管理员允许该权限。GHCR 包默认可能为私有；私有包拉取时需先通过拥有 `read:packages` 权限的个人访问令牌执行 `docker login ghcr.io`。包的可见性由仓库所有者管理，工作流不自动更改。

服务器使用预构建镜像时，保留 `.env` 原有配置，添加：

```dotenv
IMAGINE_IMAGE=ghcr.io/coinlet/huggingimage:latest
```

然后执行，无需在服务器上构建：

```bash
git pull
docker compose pull
docker compose up -d --no-build
```

如果已使用 Linux host 网络部署，继续使用同一配置文件：

```bash
docker compose -f compose.host.yaml pull
docker compose -f compose.host.yaml up -d --no-build
```

保持原目录、Compose 项目名、数据卷及加密密钥，即保留 SQLite 数据库、作品和提供商配置。固定版本时可把 `IMAGINE_IMAGE` 改为 `ghcr.io/coinlet/huggingimage:1.2.3` 或对应的 `sha-...` 标签。留空或删除此变量仍使用本地 `grokimage:latest` 镜像。

### Linux 服务器：宿主机联网正常、bridge 容器连接超时

若容器已经解析出 IP，但 `curl` 卡在 `Trying ...:443`，而宿主机访问同一地址正常，需排查 Docker 转发、NAT 和防火墙。可以先使用项目提供的独立 host 网络配置，让应用直接使用宿主机网络：

```bash
docker compose -f compose.host.yaml up -d --no-build --pull never
```

该文件单独使用，不与默认 `compose.yaml` 合并。以上命令复用服务器上已有的 `grokimage:latest` 镜像，无需为切换网络重新构建。保持相同的项目目录、`.env` 和 Compose 项目名，即沿用原 `imagine-data` 数据卷；如果原来使用 `-p` 指定项目名，切换时仍需使用相同的 `-p`。不要执行 `down -v`。

host 模式适用于 Linux Docker Engine。它共享宿主机的网络命名空间，不使用 `ports` 映射；`PUBLISH_HOST` 和 `PUBLISH_PORT` 会直接成为进程的监听地址和端口，默认仍是 `127.0.0.1:3001`。可继续使用反向代理；直接从公网访问时设置 `PUBLISH_HOST=0.0.0.0`。目标端口必须未被其他进程占用。

独立配置也为镜像构建设置 `build.network: host`，后续需要重新构建时，构建阶段的联网同样使用宿主机网络。

此方式绕过 bridge，不修改宿主机防火墙或自行处理 DNS；网络隔离也相应减少。它是部署替代方案，不会修复服务器上其他容器的 bridge 网络。后续更新、日志与停止操作继续带相同的配置文件：

```bash
docker compose -f compose.host.yaml logs -f --tail=100
docker compose -f compose.host.yaml ps
docker compose -f compose.host.yaml up -d --build
```

排查 bridge 本身时，在宿主机检查 `sysctl net.ipv4.ip_forward`、`iptables -S FORWARD`、`iptables -S DOCKER-USER` 和 `iptables -t nat -S POSTROUTING`（nftables 后端查看对应 nftables 规则）。先根据实际规则定位，不直接清空防火墙或把所有转发改为 ACCEPT。

参考：[Docker host 网络](https://docs.docker.com/engine/network/drivers/host/)、[Docker 防火墙与 NAT](https://docs.docker.com/engine/network/packet-filtering-firewalls/)。

## 验证

```bash
npm run check
npm test
npm run build
```

默认测试在进程内执行真实 Express 路由与图片处理，并以模拟提供商验证登录、文生图、收藏、下载、错误脱敏和取消；另有真实 FLUX / Qwen API 定义的配置识别、AI 输出校验与回退、Token 保留与防误发、模板、Gradio 队列、两种编辑请求格式、URL 限制与 Key 加密测试。

允许监听本地端口时，可额外运行真实 HTTP 模拟服务集成测试：

```bash
npm run test:network
```

真实模型调用需自行提供有效的 Key 或 Space；模拟测试不会验证账户权限、实际模型质量与费用。

## 参考与图片来源

- [xAI 图片生成文档](https://docs.x.ai/developers/model-capabilities/images/generation)
- [xAI 图片编辑文档](https://docs.x.ai/developers/model-capabilities/images/editing)
- [Gradio JavaScript Client](https://www.gradio.app/guides/getting-started-with-the-js-client)
- 首页示例摄影来自 [Unsplash](https://unsplash.com)，原始图片 ID 见 `src/examples.ts`。

## 图片编辑返回 HTTP 554 / 524

如果提供商域名经过腾讯云 EdgeOne，554 / 524 可能表示 CDN 等待源站响应超时，不能仅据此判定 API 地址错误。图片编辑通常需要较长处理时间；EdgeOne 的 HTTP 应答超时默认是 15 秒。

由域名管理员在 EdgeOne 的站点规则引擎为 API 域名配置「回源超时时间 → HTTP 应答超时时间」，按实际耗时提高，例如 120 秒；或使用提供商提供的不经过该 CDN 的 API 地址。本应用的上游 HTTP 空闲等待时间为 180 秒，增加前端等待时间不能延长 CDN 超时。若编辑仍超过该时间，应采用提供商支持的异步任务接口或流式协议，当前图片适配器使用同步图片接口。

应用会在新失败记录中保留脱敏后的响应摘要、请求端点和上游请求标识；检测到 EdgeOne 标记时明确提示回源超时。不会自动重试可能仍在执行的生成请求，以免重复产生任务或费用。

参考：[EdgeOne 异常状态码](https://www.tencentcloud.com/document/product/1145/58009)、[回源超时时间配置](https://cloud.tencent.com/document/product/1552/104992)。


## 资源请求方式

应用直接通过 Node HTTP(S) 请求读取提供商返回的资源地址。DNS 解析和连接路由交给运行环境，不执行独立公网 DNS 查询或 IP 分类检查。旧的 `ALLOW_PRIVATE_PROVIDERS`、`FAKE_IP_DNS_FALLBACK` 配置已不再使用。

### 连续图片编辑

打开作品或点击编辑，可在同一窗口横向滑动查看原图及全部编辑版本，提示词、模型等信息随当前图片同步切换。也可使用左右方向键、翻页按钮与缩略图。输入新提示词后可直接基于当前版本继续编辑，完成后自动展示新版本；从旧版本继续编辑会保留同组的其他分支。旧记录会根据任务中的来源图片自动恢复编辑关系。


提交生成或编辑提示词后会立即打开创作窗口，显示提示词和模糊占位图。服务端接受任务后，占位记录会保存至 SQLite，刷新页面仍可查看进度。成功后在同一位置填入图片；失败或取消后可手动删除，或点击“重试这张图片”，保留原图片 ID、提示词与版本位置。批量生成中可单独重试失败的图片，已成功的图片保持不变。请求尚未送达服务端时的临时失败占位仅保留在当前页面。


### 图片分辨率

生成框和连续编辑窗口均可设置分辨率：默认尺寸、长边 512 / 1024 / 2048 像素，或自定义宽高。预设保持当前画面方向并将像素对齐到 8 的倍数；自定义宽高范围为 64–4096，需为 8 的倍数，画面比例由所填宽高确定。默认尺寸保留已有行为。所选宽高保存在任务中，失败重试时复用；结果详情显示模型实际返回的像素尺寸。

- OpenAI 兼容接口：通过 `size=宽x高` 发送，具体可用尺寸由所选模型决定；部分模型仅接受固定尺寸。
- Hugging Face：通过模板中的 `{{width}}`、`{{height}}` 传入；Space 未提供或未映射宽高参数时，输出尺寸仍由模型决定。
- xAI：提供默认、1K、2K 档位，使用官方 `resolution` 参数，实际像素尺寸由模型结合比例确定，不发送任意宽高。

参考：[xAI 图片生成分辨率参数](https://docs.x.ai/developers/model-capabilities/images/generation)。


### 第三方 MCP 图片提供商

本应用可以作为 MCP 客户端，调用第三方 MCP 服务的生图和编辑工具。它与 xAI、OpenAI 兼容服务、HF Spaces 一样出现在工作台的提供商列表中，继续使用现有 SQLite 记录、分辨率、任务队列、原位重试与连续编辑。

1. 在“提供商设置”中添加连接，选择 **MCP 服务**。
2. 填写完整 MCP 端点，例如 `https://example.com/mcp` 或 `https://example.com/sse`，选择自动识别、Streamable HTTP 或 SSE。
3. 如服务要求鉴权，在密钥栏填写 Token，选择 Bearer 或 X-API-Key；密钥加密保存在服务器，不填写到参数模板中。
4. 点击“读取工具并填写”。此操作执行 MCP 初始化与 `tools/list`，不会调用图片生成。可识别的图片工具、宽高、提示词和推理默认值会自动填入。
5. 分别启用并选择生成、编辑工具。检查参数模板，补齐标出的未知必填参数；可查看工具原始 JSON Schema。
6. 保存连接，然后在创作框选择该提供商。

例如，生成工具的参数模板可以是：

```json
{
  "prompt": "{{prompt}}",
  "width": "{{width}}",
  "height": "{{height}}"
}
```

编辑工具可以使用：

```json
{
  "prompt": "{{prompt}}",
  "image_base64": "{{image_base64}}"
}
```

模板变量保留数字类型；`{{image}}` / `{{image_data_uri}}` 是 PNG data URI，`{{image_base64}}` 是纯 Base64，`{{images_b64_json}}` 是 data URI 数组的 JSON 字符串。蒙版使用 `{{mask}}` 或 `{{mask_base64}}`；尺寸可用 `{{width}}`、`{{height}}`、`{{size}}`（例如 `1280x720`）及 `{{aspect_ratio}}`。另可使用提示词、负向提示词、seed、steps、guidance、model 和 count。编辑工具需要能接收图片内容；仅接受自身文件 ID、公开 HTTP 图片 URL 或服务端路径的工具，需第三方提供支持 data URI / Base64 的图片输入接口。

默认自动读取 MCP 的 Image 内容、结构化图片 URL、JSON 文本、Markdown 图片、内嵌图片资源及 MCP 图片资源链接。输出路径从整个工具结果开始，例如 `structuredContent.images.0` 或 `content.0`；留空自动读取。受保护的同源图片下载继续使用该服务的凭证，跨域不会转发凭证。第三方服务器返回的磁盘路径不会被当成本服务的文件读取。

每次工具调用取一张图片，生成多张时逐次调用并递增 seed。工具必须在调用完成后返回可读取图片；仅返回异步任务 ID 的服务暂不自动猜测其查询/轮询工具。支持远程 Streamable HTTP 和旧版 SSE，不启动第三方 stdio 命令，不自动完成交互式 OAuth 登录。取消会尝试中止请求，但第三方已开始的推理和计费是否停止由其实现决定。

客户端基于 [官方 MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/client)；这里新增的是第三方 MCP 提供商接入，不是对外发布本应用的 MCP 服务端。


### 移动设备使用

工作台中点击已生成或上传的图片可进入全屏预览，再轻点一次图片返回，保留当前版本和提示词。手机支持双指缩放（最高 8 倍）与放大后拖动，滑动或双指操作不会触发关闭；电脑可使用滚轮缩放、拖动、顶部缩放按钮或 Esc 返回。

页面适配 320px 起的窄屏，手机上提供抽屉导航、双列作品和全屏设置/图片编辑窗口。触控按钮使用至少 44px 的点击区域，表单输入保持 16px 字号，并适配安全区。提供商列表可横向滚动，长 JSON 和 MCP 工具定义在窗口内换行/滚动。

手机创作框默认收起分辨率设置，点击“分辨率”展开；实际高度变化会同步为作品列表预留空间。软键盘打开时创作框跟随可见视口，在提示词输入期间收起额外选项；编辑自定义宽高或高级参数时保留正在输入的面板。连续编辑窗口保留横向切图、同步提示词及底部提交区域。


移动端的图片创作页采用固定的上下两区：图片浏览占据上方剩余空间，提示词输入框与提交/重试按钮固定在底部，页面本身不再纵向拉长。模型、分辨率、比例、批量张数、种子、步数、引导系数、负向提示词、蒙版及图片详情统一收进“设置”弹层，只有弹层内容需要滚动；关闭弹层即回到当前图片与输入框。图片左右滑动和版本切换继续可用，切换图片后显示对应的提示词。


### 分组作品与素材库

“我的作品”按创作组展示，每组使用最初的图片作为封面，标注版本数量；从上传照片开始编辑的组会显示上传原图。点击封面仍可左右查看全部编辑版本。删除封面后使用该组最早剩余的版本，收藏仍可单独收藏任意版本。

“素材库”在侧栏中独立展示。默认的本地素材库存放于 `DATA_DIR/assets/local/`，新增本地库使用 `DATA_DIR/assets/<素材库 ID>/`。沿用现有 Docker 数据卷，升级镜像会保留文件；备份时仍需备份整个 `data/` 及加密密钥。

在 **设置 → 素材库** 中添加、编辑、测试或移除来源：

- **本地**：由本服务管理的目录，可直接通过页面上传文件和创建文件夹；默认本地库始终保留。
- **S3 兼容**：填写 Endpoint、Bucket、Region（默认 `us-east-1`；如 R2 可使用 `auto`）及可选根目录前缀。填写 Access Key ID / Secret Access Key，可选 Session Token；默认使用 Path-style，亦可选择虚拟主机方式。来源需允许 `ListObjectsV2`、`GetObject` 和上传所需的 `PutObject`。
- **WebDAV**：填写完整 WebDAV 根地址及用户名/密码或应用密码。目录通过 `PROPFIND Depth: 1` 读取，上传使用 `PUT`，新建目录使用 `MKCOL`。

凭证通过现有 AES-GCM 加密后保存至 SQLite，不返回浏览器。编辑时空白凭证保留原值；更换服务域名需重新填写完整凭证，或明确清除后匿名访问。移除来源只删除配置，**不删除来源文件**；重新连接同一本地目录需保留其原素材库 ID/数据库备份。

浏览器按来源的目录结构逐级浏览，支持目录分页、图片缩略图及放大预览。可将文件上传到当前目录（单文件最大 12MB），原文件下载最大 32MB；同名文件返回冲突提示，不自动覆盖。常见 PNG、JPEG、WebP、GIF、AVIF、TIFF、BMP 图片提供预览，预览统一转成 WebP；其他文件按文件图标显示并作为附件下载。

工作台图片详情（手机端在创作设置的“当前图片与提示词”中）点击 **保存到素材库**，选择来源、目录与 PNG 文件名，即可保存当前编辑版本。素材库图片预览中可点击 **编辑这张图片**，导入一份到工作台继续编辑；编辑不会直接改写素材库原文件，需再次保存并选择新文件名。

S3/WebDAV 使用服务端凭证访问，无需开放公开读权限或配置浏览器 CORS。其凭证需要具备目标目录的实际读写权限；首次接入应使用“保存并测试”检查目录访问。读取超过 32MB 的文件或超出图片解码限制的图片会被拒绝预览。
