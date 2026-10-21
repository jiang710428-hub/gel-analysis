# GelLens 凝胶电泳分析

GelLens 提供凝胶图像泳道/条带识别、IOD 测量、Marker 与浓度标注、结果估算和 CSV 导出。网页上传后优先调用 Python OpenCV + scikit-image 算法；如果后端不可用，网页会提示并回退到浏览器识别器。

## 启动完整的 Python 版本

需要 Python 3.10 或更新版本。Windows PowerShell 中在项目目录执行：

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

然后浏览器打开 <http://127.0.0.1:8000>。不要直接双击 `index.html`，否则浏览器不能访问本机 Python 服务。

上传图像通过 `POST /api/analyze` 发送到服务内存中处理，不写入磁盘。接口会返回泳道/条带坐标、IOD、检测置信度、饱和比例和背景校正方式。`POST /api/analyze` 支持灵敏度 `1–5` 以及 `roi_x1`、`roi_x2`、`roi_y1`、`roi_y2` 区域参数；`GET /api/health` 可检查服务状态。图像大小上限为 25 MB。

## GitHub Pages 与 Python 服务

GitHub Pages 只能托管静态前端，不能运行此项目的 Python/OpenCV 算法。Pages 页面会回退到浏览器算法。要让 Pages 调用单独部署的 Python API：

1. 将 `server.py` 和 Python 依赖部署到支持 ASGI/FastAPI 的服务，并确认 `/api/health` 可访问。
2. 编辑 `config.js`，把 `window.GELLENS_API_BASE` 设为 API 服务的 HTTPS 源站地址（不要在地址末尾加路径）。
3. 将更新后的 `config.js` 推送到 `main`，GitHub Pages 会重新发布。

也可以把整个项目作为一个 FastAPI 服务运行，这样网页和 API 共用一个源站，不需要修改 `config.js`。公开部署时请使用 HTTPS，并为服务配置访问限制和资源额度。

## 标注与计算

1. 上传胶图并检查泳道/条带检测，可通过灵敏度、框选、拖动和删除功能修正识别结果。
2. 选择 Marker 泳道，填写其中已知条带的分子量。其余条带需至少两个不同迁移位置的 Marker 标注才能拟合分子量。
3. 选择浓度参考泳道和条带，输入已知浓度；其他条带按 IOD 比例估算浓度。参考条带会显示用户输入的原值。
4. 设置加样孔 y 和凝胶终点 y 后计算分子量，并可导出 CSV。

分子量与浓度校准目前仍在前端执行；Python 服务负责图像检测和 IOD 测量。浓度估算假设相同上样体积且条带未饱和。该原型尚未验证为实验室定量软件；复杂背景、弯曲泳道、相邻粘连条带及极弱条带仍需人工校正。
