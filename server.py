"""FastAPI bridge between the GelLens browser UI and its Python CV modules."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from gel_analysis import analyze_image_bytes, measure_rois

ROOT = Path(__file__).resolve().parent
MAX_IMAGE_BYTES = 25 * 1024 * 1024

app = FastAPI(title="GelLens image analysis API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def _analyze_region(
    payload: bytes,
    *,
    sensitivity: int,
    roi_x1: int,
    roi_x2: int,
    roi_y1: int,
    roi_y2: int,
) -> dict:
    image = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError("无法解码图像，请上传 PNG、JPG 或 TIFF 文件。")
    height, width = image.shape[:2]
    x1, x2 = max(0, roi_x1), min(width, roi_x2)
    y1, y2 = max(0, roi_y1), min(height, roi_y2)
    if x2 - x1 < 4 or y2 - y1 < 8:
        raise ValueError("识别区域太小，请扩大框选范围。")

    result = analyze_image(image[y1:y2, x1:x2], sensitivity=sensitivity)
    for lane in result["lanes"]:
        lane["x1"] += x1
        lane["x2"] += x1
        lane["x_center"] += x1
        for band in lane["bands"]:
            band["x1"] += x1
            band["x2"] += x1
            band["y1"] += y1
            band["y2"] += y1
            band["y_center"] += y1
    result.update({"width": width, "height": height, "analysis_roi": [x1, y1, x2, y2]})
    return result


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "engine": "opencv + scikit-image"}


@app.post("/api/analyze")
async def analyze(
    request: Request,
    sensitivity: Annotated[int, Query(ge=1, le=5)] = 3,
    roi_x1: int = 0,
    roi_x2: int | None = None,
    roi_y1: int = 0,
    roi_y2: int | None = None,
) -> dict:
    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=400, detail="没有收到图像数据。")
    if len(payload) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="图像大小不能超过 25 MB。")
    try:
        if roi_x2 is None and roi_y2 is None and roi_x1 == 0 and roi_y1 == 0:
            result = await run_in_threadpool(analyze_image_bytes, payload, sensitivity=sensitivity)
        else:
            image = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
            if image is None:
                raise ValueError("无法解码图像，请上传 PNG、JPG 或 TIFF 文件。")
            height, width = image.shape[:2]
            result = await run_in_threadpool(
                _analyze_region,
                payload,
                sensitivity=sensitivity,
                roi_x1=roi_x1,
                roi_x2=width if roi_x2 is None else roi_x2,
                roi_y1=roi_y1,
                roi_y2=height if roi_y2 is None else roi_y2,
            )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/measure")
async def measure(
    image: UploadFile = File(...),
    rois: str = Form(...),
) -> dict:
    payload = await image.read()
    if not payload:
        raise HTTPException(status_code=400, detail="没有收到图像数据。")
    if len(payload) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="图像大小不能超过 25 MB。")
    try:
        regions = json.loads(rois)
        if not isinstance(regions, list) or len(regions) > 500:
            raise ValueError("ROI 列表格式无效或数量超过 500。")
        decoded = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        if decoded is None:
            raise ValueError("无法解码图像，请重新上传。")
        values = await run_in_threadpool(measure_rois, decoded, regions)
        return {"measurements": values, "background_method": "scikit-image rolling ball"}
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(ROOT / "index.html")


@app.get("/{asset_name}")
async def assets(asset_name: str) -> FileResponse:
    if asset_name not in {"app.js", "styles.css", "config.js"}:
        raise HTTPException(status_code=404, detail="资源不存在。")
    return FileResponse(ROOT / asset_name)

