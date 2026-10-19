# Computer Use 扩展（实验版）

本目录为 **YOUessi/DesktopCommanderMCP** 的自用 Computer Use 扩展设计与安装说明。保留原版 Desktop Commander 的文件、终端、进程工具；新增可观察桌面截图和有限的鼠标键盘操作。基于原仓库的 MIT 许可证。

> 状态：已经实现 MCP 工具和模拟驱动单元测试；**模拟测试通过；Mac 真实截图与鼠标点击已验证，键盘输入闭环继续验收；Tang 尚未验证**。Linux Wayland、多显示器、锁屏/无 GUI、任意浏览器 DOM、GUI 密码输入、原生 macOS 窗口焦点控制不属于当前实现。

## 功能与架构

```text
本地 MCP 客户端 (Codex / Claude Desktop / 支持 stdio MCP 的程序)
    -> src/server.ts（DC 原 MCP Server）
         -> src/tools/computer.ts（串行控制、截图 ID、超时、坐标缩放）
              -> src/computer-use/bridge.py（无 shell 的 JSON/stdio 子进程）
                   -> PyAutoGUI / Pillow / macOS Accessibility / Linux X11

现有的 read_file、edit_block、start_process、read_process_output 等工具保持不变。
```

新增 8 个工具：

| 工具 | 用途 |
| --- | --- |
| `computer_screenshot` | 截取主屏幕并返回 MCP image/jpeg；结果附 screenshot_id、图像大小 |
| `computer_screen_info` | 主屏幕逻辑宽高、平台 |
| `computer_list_windows` | 窗口清单（macOS System Events / Linux X11 wmctrl） |
| `computer_click` | 点击/双击/右键，使用截图像素坐标 |
| `computer_type` | 在当前输入焦点键入文字；可额外传入截图上的 `x/y`，在同一操作内先点击文本框再输入，避免焦点漂移 |
| `computer_key` | 按快捷键组合 |
| `computer_scroll` | 指定位置滚动 |
| `computer_drag` | 由一个图像坐标拖向另一个图像坐标 |

### 两个必须开启的安全开关

- `DC_COMPUTER_USE=1`：允许 MCP **展示**并使用 Computer Use 工具。未设置时工具甚至不会出现在 `tools/list`。
- `DC_COMPUTER_INPUT=1`：独立允许点击、拖拽、输入、快捷键和滚动。只有第一项时可观察，不可操作。

**默认都关闭。** 工具不能代替可信账户保护、操作前确认或操作系统隔离。特别是现有 DC 的 `start_process` 本身仍能执行 shell 命令，原有路径限制不是安全沙箱。

### 观察—动作—再观察

`computer_screenshot` 返回一张最多 1280×1000（默认）等比例缩放的 JPEG、截图编号和图片宽高。**后续鼠标坐标必须取自这张图片本身，而不是 macOS 的逻辑点或原始 Retina 像素。** MCP 层根据主屏幕逻辑尺寸自动换算，处理多数 Retina 缩放情形。

**输入文字时，优先在 `computer_type` 同时指定输入框对应的截图像素 `x`、`y`，该工具会在同一 Python 进程内先聚焦再输入，避免窗口焦点因截图/启动新进程而丢失。**\n\n每次输入都必须携带 `screenshot_id`；截图最多有效 120 秒，单次动作后立即作废。动作默认附带新的截图和新的编号，因此可以继续下一步。若动作超时/截图失败，状态可能不确定，**先重新截图核实，不要重复点提交/删除**。所有 GUI 事件在本 MCP 进程内串行执行；屏幕 ID 不跨进程持久化。

## 安装：macOS（建议首先在 MacBook Air 验证）

本 Fork 依赖与上游一致：Node.js >=22.12，Python3。以项目源码目录为工作目录：

```bash
git clone https://github.com/YOUessi/DesktopCommanderMCP.git
cd DesktopCommanderMCP
git checkout feat/computer-use-mvp

npm ci --include=dev
npm run build
python3 -m venv .venv-computer
.venv-computer/bin/python -m pip install --upgrade pip
.venv-computer/bin/python -m pip install pyautogui pillow

# 测试（无需操作真实桌面）
npm run test:computer
```

系统设置 → 隐私与安全性中，授权启动 MCP 的终端/应用及相关 Python 进程：**屏幕与系统音频录制（Screen Recording）**、**辅助功能（Accessibility）**。在 Mac 上请使用真实登录的桌面会话；电脑锁屏、用户会话退出或休眠时 Computer Use 不保证可用。

客户端运行配置示例（**本地** Codex `~/.codex/config.toml`；请把路径换成真实绝对路径）：

```toml
[mcp_servers.dc-computer]
command = "node"
args = ["/绝对路径/DesktopCommanderMCP/dist/index.js", "--no-onboarding"]

[mcp_servers.dc-computer.env]
DC_COMPUTER_USE = "1"
DC_COMPUTER_INPUT = "1"
DC_COMPUTER_PYTHON = "/绝对路径/DesktopCommanderMCP/.venv-computer/bin/python"
```

如果要首先只验证截图，可暂时去掉 `DC_COMPUTER_INPUT`。客户端重连后，先调用 `computer_screen_info`、`computer_screenshot`。必须亲眼确认画面正确，再在**非敏感测试窗口**尝试点击。

**注意：** Mac 的中文/日文输入法可能将常规模拟按键留在候选/组合状态；本扩展对可打印 ASCII 采用 Quartz Unicode 键盘事件直接提交，对中文、emoji、多行文字等使用系统**纯文本剪贴板临时替换并恢复**。后者会损失原剪贴板的富文本/图片格式，且存在与其他程序的剪贴板竞争。带坐标的 `computer_type` 在 macOS 上会核对点击坐标下的窗口所有者是否成为前台应用，否则拒绝发出键盘输入，以防误输到其他窗口。不要用它输入密码、令牌或其他秘密。

## 安装：Linux（Tang）

第一版仅支持 **X11 GUI 桌面**，不支持纯 SSH、无图形会话及原生 Wayland。需要与运行图形桌面的用户保持一致：

```bash
sudo apt-get update
sudo apt-get install -y python3-venv python3-tk scrot xclip wmctrl
python3 -m venv .venv-computer
.venv-computer/bin/python -m pip install pyautogui pillow

echo "$XDG_SESSION_TYPE"  # 期望 x11
echo "$DISPLAY"           # 通常 :0，但以实际用户会话为准
```

Linux Python 程序需有当前 GUI 会话可用的 `DISPLAY` 和 Xauthority 权限。不要把图形控制 MCP 直接启动为 root。GPU 训练的启动、日志和断点恢复继续使用上游终端工具，不应依赖 GUI 进程会话保活。

## 现阶段远程接入：请勿直接把 DC 暴露公网

**这份扩展目前是本地 stdio MCP，不包含独立远程网关**。与官方 Remote 的区别：

- `npx @wonderwhy-er/desktop-commander@latest remote` 默认仍然使用 Desktop Commander 的官方托管服务，并不等于自建后端。
- 这个 Fork 新增的工具不能保证会自动出现在官方 Remote 账号的插件操作列表里。
- 如需自己从远程控制，优先选择支持本地 MCP 的客户端 + Tailscale/SSH，或使用有权限的 OpenAI Secure MCP Tunnel。后者可把本地 stdio MCP 连接到获支持的 OpenAI 产品，无需自建公网端口：
  https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- **ChatGPT 自定义 MCP 的读写权限可能受套餐限制。** 截至 2026-10 的 OpenAI 官方说明，自定义 MCP 的完整写入/修改目前只向 Business、Enterprise、Edu 的测试计划开放，Pro 用户通常仅能自定义 read/fetch 工具：
  https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt

不要通过把点击接口标注成“只读”来绕过客户端限制；这会误导安全审查。想在不支持写入 MCP 的账户上做自主桌面操作，应使用支持本地 MCP 的客户端，或自建经授权的 Agent API。

## 维护要点

- **上游同步**：先比较 upstream/main，再合入本 Fork，保持 `feat/computer-use-mvp` 分支测试通过。
- **进程管理**：本地 MCP 跟随客户端启动退出；真正的长训练任务建议用 `tmux` / `systemd`，写入可恢复的日志和 checkpoint。
- **桌面保活**：本地会话需要解锁且有画面输出。安全地禁用锁屏并不是生产部署的默认建议；优先采用专用测试机器/虚拟桌面。
- **密钥**：不能把隧道 token、SSH 私钥或 OAuth 凭据提交到 GitHub；日志做脱敏。
- **审计**：新增 `computer_type` 参数会在本地 DC 工具调用日志中脱敏，截图图像不会被存入本地工具历史；但运行时图像仍会发送给模型所连接的客户端。审计不能替代对客户端的信任。
- **关闭入口**：去掉 `DC_COMPUTER_USE` / `DC_COMPUTER_INPUT` 并重启 MCP 即可完全撤除 GUI 访问。
- **图形操作风险**：可能误操作、删除数据、发送消息或导致意外支出；先在测试账户/专用桌面运行，再谨慎扩大权限。

## 验收清单

1. `npm run build` 无 TypeScript 报错；`node --test test/test-computer-use.js` 通过。
2. 两个开关均关闭时，新工具不对外暴露。
3. 只启用 `DC_COMPUTER_USE` 时可截图，但不能点击。
4. Mac 截图尺寸/Retina 坐标换算正确，展示主屏幕真实画面。
5. 在文本编辑器中点击输入、执行快捷键，动作后返回新截图；旧截图编号无法再操作。
6. 断开桌面权限、传错截图编号、超时和越界时明确失败。
7. X11 Linux 单独测试，不把 macOS 成功当作 Linux 的验收结论。

## 后续路线

- Wayland 通过 Desktop Portal / libei 完成屏幕、键鼠桥接；多屏幕独立坐标系。
- 优先 Playwright 控制网页 DOM，无法访问语义节点时才退回截图点击。
- 增加受限操作账户、焦点窗口核验、用户确认机制及更严格的操作日志。
- 远程连接：先验证客户端套餐与隧道权限，再决定是否自建具有 OAuth/RBAC、设备心跳、任务去重的 MCP 网关。
