"""Calibration and concentration calculations kept separate from CV detection."""
from __future__ import annotations

import math
from typing import Any, Iterable

import numpy as np


def _rf(y: float, well_y: float, gel_end_y: float) -> float:
    if not all(math.isfinite(float(v)) for v in (y, well_y, gel_end_y)):
        raise ValueError("y coordinates must be finite")
    distance = gel_end_y - well_y
    if distance <= 0:
        raise ValueError("gel_end_y must be greater than well_y")
    return (float(y) - well_y) / distance


def fit_molecular_weight(
    marker_bands: Iterable[dict[str, Any]],
    sample_bands: Iterable[dict[str, Any]],
    *,
    well_y: float,
    gel_end_y: float,
    unit: str = "bp",
) -> dict[str, Any]:
    """Fit log10(MW) against Rf and annotate sample bands.

    Marker values must all use the declared unit. Two distinct marker positions
    are required; extrapolated samples are explicitly flagged in the output.
    """
    if unit not in {"bp", "kDa"}:
        raise ValueError("unit must be 'bp' or 'kDa'")
    markers = [m for m in marker_bands if m.get("molecular_weight") is not None]
    if len(markers) < 2:
        raise ValueError("At least two annotated marker bands are required")
    marker_rf = np.asarray([_rf(m["y_center"], well_y, gel_end_y) for m in markers], dtype=float)
    marker_mw = np.asarray([float(m["molecular_weight"]) for m in markers], dtype=float)
    if np.any(~np.isfinite(marker_mw)) or np.any(marker_mw <= 0):
        raise ValueError("Marker molecular weights must be finite and positive")
    if np.ptp(marker_rf) <= 1e-9:
        raise ValueError("Marker bands must have distinct migration positions")
    log_mw = np.log10(marker_mw)
    slope, intercept = np.polyfit(marker_rf, log_mw, 1)
    predicted = slope * marker_rf + intercept
    ss_res = float(np.square(log_mw - predicted).sum())
    ss_tot = float(np.square(log_mw - log_mw.mean()).sum())
    r_squared = 1.0 if ss_tot == 0 and ss_res < 1e-12 else (0.0 if ss_tot == 0 else 1 - ss_res / ss_tot)
    lo, hi = float(marker_rf.min()), float(marker_rf.max())
    samples = []
    for band in sample_bands:
        rf = _rf(band["y_center"], well_y, gel_end_y)
        item = dict(band)
        item.update({
            "rf": rf,
            "molecular_weight": float(10 ** (slope * rf + intercept)),
            "molecular_weight_unit": unit,
            "outside_marker_range": not lo <= rf <= hi,
        })
        samples.append(item)
    return {
        "slope": float(slope), "intercept": float(intercept), "r_squared": float(r_squared),
        "marker_count": len(markers), "marker_rf_range": [lo, hi],
        "unit": unit, "samples": samples,
    }


def estimate_concentrations(
    bands: Iterable[dict[str, Any]],
    *,
    reference_iod: float,
    reference_concentration: float,
    reference_volume_ul: float | None = None,
) -> list[dict[str, Any]]:
    """Estimate concentrations from IOD and, when supplied, lane volumes."""
    if not math.isfinite(reference_iod) or reference_iod <= 0:
        raise ValueError("reference_iod must be finite and positive")
    if not math.isfinite(reference_concentration) or reference_concentration < 0:
        raise ValueError("reference_concentration must be finite and non-negative")
    if reference_volume_ul is not None and (not math.isfinite(reference_volume_ul) or reference_volume_ul <= 0):
        raise ValueError("reference_volume_ul must be positive when provided")
    results = []
    for band in bands:
        result = dict(band)
        iod = float(band.get("iod", 0))
        volume = band.get("loading_volume_ul")
        if not math.isfinite(iod) or iod < 0:
            raise ValueError("Band IOD must be finite and non-negative")
        if volume is not None and (not math.isfinite(float(volume)) or float(volume) <= 0):
            raise ValueError("loading_volume_ul must be positive when provided")
        if (volume is None) != (reference_volume_ul is None):
            result["concentration"] = None
            result["concentration_status"] = "missing_volume_for_volume_correction"
        else:
            volume_factor = 1.0 if volume is None else reference_volume_ul / float(volume)
            result["concentration"] = float(reference_concentration * iod / reference_iod * volume_factor)
            result["concentration_unit"] = "ng/μL"
            result["concentration_status"] = "estimated"
        results.append(result)
    return results
