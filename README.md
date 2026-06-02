# 手势交互实验室 · GestureLab

用**手势操控网页**的交互式 Demo。通过摄像头实时识别手部关键点（基于
[MediaPipe Hand Landmarker](https://developers.google.com/mediapipe)），
你可以在空中**移动光标、抓取拖拽卡片、隔空绘画**——无需鼠标和键盘。
没有摄像头时会自动回退到鼠标模式。

> A gesture-controlled website: real-time hand tracking lets you point, pinch
> to drag, draw in the air, and reset the scene — all with your hand. Falls
> back to mouse control when no camera is available.

## ✋ 支持的手势 / Gestures

| 手势 | 动作 |
| --- | --- |
| 👉 **指**（伸出食指） | 移动光标 |
| 🤏 **捏**（拇指 + 食指捏合） | 抓取 / 拖动卡片（松开会“甩”出去） |
| 🤏🤏 **双手捏合** | 缩放 / 平移整个场景 |
| 🖐 **张开**（五指张开） | 释放手中的卡片 |
| ✌️ **比耶** | 切换「拖拽 / 绘画」模式 |
| ✊ **握拳** | 重置场景并清空画布 |

支持**双手**同时操作，每只手有独立的彩色光标。双手同时捏合并拉开 / 靠近即可
缩放，移动双手中点可平移视图。

## 🚀 运行 / Run

摄像头需要 **安全上下文**（`https://` 或 `localhost`），直接用
`file://` 打开无法授权摄像头，请用本地服务器：

```bash
# 任选其一：
python3 -m http.server 8000      # 然后访问 http://localhost:8000
npm start                        # 同上
npx serve -l 8000 .              # 或用 serve
```

打开后点击 **「启用摄像头开始」**，允许摄像头权限即可。
也可以点 **「用鼠标体验」**（鼠标模式：按住左键 = 捏，`D` 切换绘画，`C` 重置）。

> 摄像头画面只在本地浏览器中处理，**不会上传**到任何服务器。
> 手势模型与运行时从 CDN（jsDelivr / Google Storage）按需加载，首次使用需联网。

## 📱 手机上使用 / On mobile

可以。手机浏览器（iOS Safari / Android Chrome）完全支持：

- **触摸模式**：直接打开即可用——**单指**拖拽卡片 / 绘画，**双指捏合**缩放，
  底部按钮切换「绘画 / 拖拽」与「重置」。
- **摄像头手势模式**：手机摄像头同样支持,但浏览器要求**安全上下文（HTTPS）**——
  用电脑局域网 IP 的 `http://` 打开**无法授权摄像头**。把站点部署到任意 HTTPS
  托管即可，例如 **GitHub Pages**：仓库 *Settings → Pages → Deploy from a
  branch*，选择分支根目录,然后访问 `https://<用户名>.github.io/claude-code/`。
- 提示：手持手机时一只手要拿着设备，**双手手势**（双手捏合缩放、✌️/✊）更适合把
  手机**架起来**用；手持时用触摸的双指缩放最顺手。

## 🧩 项目结构 / Structure

```
index.html          页面结构 / HUD / 启动遮罩
css/style.css       玻璃拟态样式、光标、动画
js/gestures.js      手势识别（纯函数，可单测）
js/app.js           摄像头、手部追踪、交互、绘画、鼠标回退
test/gestures.test.mjs  手势识别单元测试
```

## ✅ 测试 / Test

手势识别逻辑（`js/gestures.js`）是无 DOM 的纯函数，附带单元测试：

```bash
node --test        # 或 npm test
```

## 🛠 技术要点 / How it works

- **手部追踪**：MediaPipe Tasks-Vision `HandLandmarker`，每帧输出 21 个关键点。
- **手势分类**：基于关键点的相对几何关系判断每根手指是否伸展；捏合检测带
  **迟滞阈值**（hysteresis）避免抖动；阈值均按手掌尺寸归一化，远近通用。
- **交互**：食指指尖映射为屏幕光标（镜像 + 增益，便于触达边缘），捏合做抓取/绘画，
  整手姿势（比耶 / 握拳）经稳定帧去抖后触发一次性动作。
