# 买家评论生成工具（本地运行 · AI 模拟文案）

按《买家评论生成规则 v0.4.3 完整版》实现的 Windows 本机网页工具：输入产品名称、卖点文字或包装图片，
生成可编辑、可导出的**模拟买家评论**。

> 输出的全部内容是 **AI 生成的模拟评论文案**，不代表真实顾客反馈，不得作为真实消费者评价对外表述。
> 规范的做法是只用它做文案测试、素材准备和内部评审。

---

## 一、Windows 启动步骤

1. 确认已安装 Node.js 18 或更高版本（本机已验证：Node v24.21.0）。
   在命令行执行 `node -v` 能显示版本号即可。
2. 双击项目目录里的 **`启动.cmd`**。
   - 首次运行会自动执行 `npm install` 安装唯一依赖 `exceljs`（约 1–2 分钟，需要联网）。
   - 之后会自动打开浏览器并访问 <http://127.0.0.1:8787>。
3. 关闭服务：在启动窗口按 `Ctrl + C`。

命令行方式（等价）：

```powershell
cd "D:\评论\买家评论生成工具"
npm install        # 首次
node server.js
```

端口 8787 被占用时会自动顺延到 8788、8789……以窗口里打印的地址为准。

---

## 二、模型配置方式

### 1. 默认：自动复用本机 Codex 的模型配置（已验证可用）

程序启动时会**只读**读取本机 Codex 配置，把接口地址、模型 ID 和密钥当作服务端配置使用：

| 复用内容 | 来源 |
| --- | --- |
| 接口地址 | `~/.codex/config.toml` → `model_providers.<当前 provider>.base_url` |
| 密钥 | 同上的 `experimental_bearer_token` / `api_key` / `env_key` |
| 模型 ID | `config.toml` 顶层 `model` 字段 |

本机实测结果：`https://api.deepseek.com` + `deepseek-flash`，密钥以 `sk-****（掩码）` 形式显示，只在服务端使用。
网页里只会显示掩码后的密钥，**不会**把密钥返回给浏览器。

> 注意：能复用的是「接口地址 + 密钥 + 模型 ID」这类 API 凭据。
> Codex 自身的登录态（`auth.json` 里的 ChatGPT OAuth token）不是通用 API 凭据，程序不会拿它去调用模型。

### 2. 网页里改（推荐给日常使用）

点右上角 **「模型设置」**，可以填写：

- 接口地址（OpenAI 兼容，末尾不用写 `/v1`）
- 模型 ID（可点「读取可用模型」直接从接口拉真实模型 ID，不要按显示名猜）
- 密钥（留空表示保持不变）
- 图片识读方式：`自动` / `只用模型读图` / `只用本地 OCR + 文本模型整理`
- 写作温度、单次输出上限
- 外部 OCR / 视觉接口地址与模型（可选）

保存后写入项目目录的 `config.json`（明文，仅存在本机，不会上传）。

### 3. 环境变量 / .env（适合脚本化）

复制 `config.example.json` 为 `config.json`，或在项目目录建 `.env`：

```ini
BUYER_REVIEW_BASE_URL=https://api.deepseek.com
BUYER_REVIEW_API_KEY=你的密钥
BUYER_REVIEW_MODEL=deepseek-flash
BUYER_REVIEW_VISION=auto
BUYER_REVIEW_TEMPERATURE=0.95
BUYER_REVIEW_MAX_TOKENS=32000
BUYER_REVIEW_PORT=8787
# 可选：外部 OCR / 视觉接口
BUYER_REVIEW_OCR_BASE_URL=
BUYER_REVIEW_OCR_API_KEY=
BUYER_REVIEW_OCR_MODEL=
```

优先级（高 → 低）：环境变量 → `config.json` → `.env` → 自动复用 Codex 配置 → 内置默认值。

---

## 三、实际验证过的能力（2026-09-27 本机实测）

| 功能 | 状态 | 证据 |
| --- | --- | --- |
| 文本调用连通 | ✅ 跑通 | `/api/config/test` 文本调用成功，返回「连通」 |
| 图片理解（模型读图） | ✅ 跑通 | `deepseek-flash` 正确读出测试包装图上的全部中文文字 |
| 文字输入 → 事实卡 | ✅ 跑通 | 生成「明确信息 6 条 / 待确认 5 条」，未把「修护」猜成功效 |
| 图片 → 事实卡 | ✅ 跑通 | `mode=vision`，参数、成分、批号均识别正确，功效列入「不得写的内容」 |
| 生成 10 条评论 | ✅ 跑通 | 18 条候选 → 事实与正面检查通过 17 条 → 去重后输出 10 条，耗时 44–84 秒 |
| 篇幅分布 | ✅ 命中 | 约 100 字长评 2 条、主体 55–85 字 6 条、短评 2 条 |
| 全部正面 | ✅ 命中 | 生成结果无降分、保留意见、先贬后夸表达 |
| 逐条编辑 | ✅ 跑通 | 网页里改文案后字数徽章实时更新 |
| 单条重新生成 | ✅ 跑通 | 返回 91 字长评，无违规项 |
| 复制评论 | ✅ 跑通 | 单条复制、复制全部均写入剪贴板成功 |
| 导出 Markdown | ✅ 跑通 | 见 `exports\*_模拟评论_*.md` |
| 导出 Excel | ✅ 跑通 | `序号 / 产品名称 / 评论内容` 三列，末尾句号已去除，另含「说明」工作表 |
| 网页图片上传 | ✅ 跑通 | 选择图片后出现缩略图，前端转 data URL 交给服务端 |
| Windows 本地 OCR | ✅ 可用 | 系统已安装 `zh-Hans-CN` 识别语言包，离线可跑（会有错字，需人工核对） |

### 能力边界与需要你注意的地方

- 事实卡里「待确认」的内容不会参与生成；生成前必须勾选「我已核对以上事实卡」。
- 事实卡里的信息越少，评论主题越容易相近。程序会限制同一卖点约 3 条，事实不足时会优先保证条数。
- 程序自检（正面、事实、去重、篇幅）是规则化检查，**不等于**独立盲测或人工验收，报告里也如实标注。
- 视觉调用失败时自动回退：外部 OCR 接口 → Windows 本地 OCR → 提示手工填写，网页会明确说明当前用的是哪条路径。
- 生成一次约 1–2 分钟（推理型模型会先花大量 token 思考）；「单次输出上限」默认 32000，若接口报输出被截断可调高。

---

## 四、目录结构

```
买家评论生成工具\
├─ 启动.cmd                  双击启动（含首次依赖安装）
├─ server.js                 本地服务端：模型调用、事实卡、生成、导出
├─ src\
│  ├─ config.js              配置优先级与 Codex 配置复用
│  ├─ model.js               OpenAI 兼容调用（含输出预算自动升级）
│  ├─ prompts.js             事实卡 / 候选 / 单条重写的提示词
│  ├─ rules.js               加载规则蓝本
│  ├─ validate.js            字数、全正面、事实边界、语义去重、筛选
│  ├─ exporters.js           Markdown 与 Excel 导出
│  ├─ ocr-windows.js         本地 OCR 兜底
│  └─ ocr-ps51.ps1           Windows.Media.Ocr 调用脚本
├─ public\                   网页前端（原生 HTML/CSS/JS，无构建步骤）
├─ rules\买家评论生成规则_v0.4.3_完整版.md   规则蓝本（提示词直接引用）
├─ scripts\debug-generate.js 排查模型输出用的调试脚本
├─ exports\                  导出示例
└─ config.example.json       配置示例
```

## 五、接口一览（都在服务端调用模型）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/config` | 读取当前配置（密钥掩码） |
| POST | `/api/config` | 保存配置到 `config.json` |
| POST | `/api/config/models` | 拉取接口下的真实模型 ID |
| POST | `/api/config/test` | 连通性 + 读图能力探测 |
| POST | `/api/facts` | 文字/图片 → 产品事实卡 |
| POST | `/api/comments` | 生成 10 条（候选 → 自检 → 去重 → 筛选） |
| POST | `/api/comments/regenerate` | 单条重新生成 |
| POST | `/api/validate` | 对编辑后的评论再跑一遍规则检查 |
| POST | `/api/export/markdown` | 导出 Markdown |
| POST | `/api/export/excel` | 导出 Excel（.xlsx） |
