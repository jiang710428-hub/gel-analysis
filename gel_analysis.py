"""Classical computer-vision helpers for agarose and protein gel images.

The module returns pixel-coordinate ROIs and background-corrected integrated
optical density (IOD). It deliberately leaves image interpretation and
calibration annotations editable by the caller.
"""
from __future__ import annotations

from typing import Any

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks, peak_widths
from skimage.restoration import rolling_ball


def _gray(image: np.ndarray) -> np.ndarray:
    if image is None or image.size == 0:
        raise ValueError("Image is empty")
    if image.ndim == 3:
        if image.shape[2] == 4:
            image = cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
        else:
            image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if image.ndim != 2:
        raise ValueError("Expected a grayscale, BGR, or BGRA image")
    if image.dtype == np.uint8:
        return image.astype(np.float32)
    image = image.astype(np.float32)
    lo, hi = np.nanpercentile(image, [0.5, 99.5])
    if not np.isfinite(hi - lo) or hi <= lo:
        raise ValueError("Image has no usable intensity range")
    return np.clip((image - lo) * (255.0 / (hi - lo)), 0, 255)


def _smooth_profile(values: np.ndarray, sigma: float) -> np.ndarray:
    return gaussian_filter1d(values.astype(np.float32), max(1.0, sigma), mode="nearest")


def _regions_from_mask(mask: np.ndarray) -> list[tuple[int, int]]:
    edges = np.flatnonzero(np.diff(np.r_[False, mask, False].astype(np.int8)))
    return [(int(a), int(b)) for a, b in zip(edges[::2], edges[1::2]) if b > a]


def analyze_image(
    image: np.ndarray,
    *,
    sensitivity: int = 3,
    rolling_radius: int | None = None,
    gel_top: int = 0,
    gel_bottom: int | None = None,
) -> dict[str, Any]:
    """Detect lanes/bands and calculate IOD for one gel image.

    Coordinates are pixel coordinates in the input image. ``gel_top`` and
    ``gel_bottom`` limit the analysis crop; they are independent of the well
    coordinate used later for Rf calibration.
    """
    if not 1 <= sensitivity <= 5:
        raise ValueError("sensitivity must be between 1 and 5")
    gray = _gray(image)
    height, width = gray.shape
    gel_bottom = height if gel_bottom is None else int(gel_bottom)
    gel_top = int(gel_top)
    if gel_top < 0 or gel_bottom > height or gel_bottom - gel_top < 8:
        raise ValueError("Invalid gel crop bounds")

    edge = max(2, min(height, width) // 40)
    border = np.concatenate((gray[:edge].ravel(), gray[-edge:].ravel(),
                             gray[:, :edge].ravel(), gray[:, -edge:].ravel()))
    polarity = 1 if np.median(border) < np.median(gray) else -1
    radius = rolling_radius or max(12, min(height, width) // 45)
    background = rolling_ball(gray, radius=radius).astype(np.float32)
    signed_signal = polarity * (gray - background)
    signal = np.maximum(signed_signal, 0)
    crop_signal = signal[gel_top:gel_bottom]

    # Lane signal is integrated vertically; smoothing bridges small gaps caused
    # by uneven bands while retaining the valleys between adjacent lanes.
    lane_profile = _smooth_profile(crop_signal.sum(axis=0), max(2, width * 0.004))
    lane_scale = np.percentile(lane_profile, 98) - np.percentile(lane_profile, 35)
    if lane_scale <= 0:
        return {"width": width, "height": height, "polarity": polarity,
                "background_method": "scikit-image rolling ball", "lanes": []}
    lane_threshold = np.percentile(lane_profile, 35) + lane_scale * (0.09 + (sensitivity - 3) * 0.025)
    peaks, props = find_peaks(
        lane_profile,
        height=lane_threshold,
        prominence=lane_scale * (0.08 + (sensitivity - 3) * 0.02),
        distance=max(3, int(width * 0.025)),
    )
    lane_bounds: list[tuple[int, int, int, float]] = []
    low, high = np.percentile(lane_profile, [35, 98])
    for idx, peak in enumerate(peaks):
        cutoff = low + (lane_profile[peak] - low) * 0.15
        left, right = int(peak), int(peak) + 1
        while left > 0 and lane_profile[left - 1] > cutoff:
            left -= 1
        while right < width and lane_profile[right] > cutoff:
            right += 1
        # A projection can join nearby lanes under a broad background hump.
        max_width = max(8, int(width * 0.18))
        if right - left > max_width:
            half = max_width // 2
            left, right = max(0, int(peak) - half), min(width, int(peak) + half)
        lane_bounds.append((left, right, int(peak), float(props["prominences"][idx] / max(high - low, 1e-6))))

    # Suppress duplicate candidate lanes whose detected regions overlap.
    lane_bounds.sort(key=lambda item: item[0])
    merged: list[tuple[int, int, int, float]] = []
    for lane in lane_bounds:
        if merged and lane[0] < merged[-1][1]:
            prev = merged[-1]
            if lane[3] > prev[3]:
                merged[-1] = (min(prev[0], lane[0]), max(prev[1], lane[1]), lane[2], lane[3])
            else:
                merged[-1] = (min(prev[0], lane[0]), max(prev[1], lane[1]), prev[2], prev[3])
        else:
            merged.append(lane)

    lanes: list[dict[str, Any]] = []
    sat = gray >= 250 if polarity > 0 else gray <= 5
    band_sensitivity = 0.34 - (sensitivity - 3) * 0.045
    for lane_index, (x1, x2, center_x, lane_confidence) in enumerate(merged):
        pad = max(1, int((x2 - x1) * 0.12))
        xa, xb = min(x2 - 1, x1 + pad), max(x1 + 1, x2 - pad)
        lane_roi = crop_signal[:, xa:xb]
        profile = _smooth_profile(lane_roi.sum(axis=1), max(1.0, height * 0.0018))
        baseline = float(np.percentile(profile, 25))
        peak_level = float(np.percentile(profile, 99))
        dynamic = max(peak_level - baseline, 0.0)
        if dynamic <= 0 or profile.size < 3:
            bands: list[dict[str, Any]] = []
        else:
            min_prominence = dynamic * (0.035 + (sensitivity - 3) * 0.012)
            peak_indices, peak_properties = find_peaks(
                profile,
                height=baseline + dynamic * band_sensitivity,
                prominence=max(1e-6, min_prominence),
                distance=max(2, int(height * 0.006)),
            )
            widths = peak_widths(profile, peak_indices, rel_height=0.65)[0] if len(peak_indices) else []
            bands = []
            for band_index, (peak, prominence, peak_width) in enumerate(
                zip(peak_indices, peak_properties.get("prominences", []), widths)
            ):
                half = max(2, int(round(float(peak_width) / 2)))
                y1, y2 = max(gel_top, gel_top + int(peak) - half), min(gel_bottom, gel_top + int(peak) + half + 1)
                roi_signal = signal[y1:y2, xa:xb]
                iod = float(roi_signal.sum())
                area_sat = float(sat[y1:y2, xa:xb].mean()) if roi_signal.size else 0.0
                local_strength = float(prominence / max(dynamic, 1e-6))
                confidence = float(np.clip(0.65 * local_strength + 0.35 * lane_confidence, 0, 1))
                bands.append({
                    "id": f"L{lane_index + 1}-B{band_index + 1}",
                    "x1": xa, "x2": xb, "y1": y1, "y2": y2,
                    "y_center": (y1 + y2) / 2,
                    "iod": iod,
                    "saturated_fraction": area_sat,
                    "quantification_usable": area_sat < 0.01,
                    "confidence": confidence,
                })
        lanes.append({
            "id": f"L{lane_index + 1}", "x1": x1, "x2": x2,
            "x_center": center_x, "confidence": lane_confidence, "bands": bands,
        })
    return {
        "width": width, "height": height, "polarity": polarity,
        "background_method": "scikit-image rolling ball",
        "signal_polarity": "bright bands" if polarity > 0 else "dark bands",
        "lanes": lanes,
    }


def analyze_image_bytes(data: bytes, **options: Any) -> dict[str, Any]:
    """Decode an uploaded image byte string and run :func:`analyze_image`."""
    buffer = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(buffer, cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError("Uploaded file is not a supported image")
    return analyze_image(image, **options)
