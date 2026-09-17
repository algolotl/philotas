# SPDX-License-Identifier: Apache-2.0
"""
Philotas object detection service.

Runs object detection and image similarity behind a small HTTP API that the
Next.js app addresses via DETECTION_URL (default http://127.0.0.1:8770).

Detection engine selection is controlled by the DETECT_ENGINE environment
variable:

  - auto (default): use the AutoGluon ObjectDetector when AG_MODEL_DIR points at
    a trained model directory (see train.py). When AG_MODEL_DIR is not set,
    initialisation fails with a message telling the operator to point AG_MODEL_DIR
    at a trained model or to set DETECT_ENGINE=ultralytics explicitly.
  - autogluon: always use the AutoGluon ObjectDetector path (AG_MODEL_DIR).
  - ultralytics: explicitly opt in to ultralytics YOLO (YOLO_MODEL, default
    yolo11n.pt). ultralytics is AGPL-3.0 licensed; a notice is logged at boot.

ultralytics is imported only under DETECT_ENGINE=ultralytics, and AutoGluon
only under an AutoGluon engine. When no engine loads, /health reports ok:false
and every detection endpoint answers 503 with a clear message.

Image similarity (/similar) uses AutoGluon's image_similarity predictor when
AutoGluon is present; otherwise it falls back to a class-profile heuristic over
YOLO detections and says so in the response (method: 'heuristic').

Run:  python detect/service.py        (or: uvicorn service:app --port 8770)
"""

import ast
import base64
import io
import os
import re
import time
import traceback
from typing import List, Optional

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="philotas-detection")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

AGPL_ULTRALYTICS_NOTICE = (
    "ultralytics is AGPL-3.0 licensed; review "
    "https://www.ultralytics.com/license before operational use"
)
SAMPLE_EVERY_FRAMES = int(os.environ.get("VIDEO_SAMPLE_EVERY", "25"))
MAX_VIDEO_FRAMES = int(os.environ.get("VIDEO_MAX_FRAMES", "40"))
DETECT_CONF = float(os.environ.get("DETECT_CONF", "0.25"))

_detector = None          # callable(image_bytes) -> [{class, score, bbox}]
_engine = "none"
_model_name = None
_class_names: List[str] = []
_similarity = None        # AutoGluon image_similarity predictor, or None
_init_error = None


def _load_image(ref: str) -> bytes:
    """Resolve a data: URL or http(s) URL to raw image bytes."""
    if ref.startswith("data:"):
        m = re.match(r"^data:image/[^;]+;base64,(.*)$", ref, re.S)
        if not m:
            raise ValueError("unsupported data URL")
        return base64.b64decode(m.group(1))
    if re.match(r"^https?://", ref):
        r = httpx.get(
            ref,
            timeout=45,
            follow_redirects=True,
            headers={"User-Agent": "philotas-detection/0.1 (+https://philotas.local)"},
        )
        r.raise_for_status()
        return r.content
    raise ValueError("image must be a data: URL or an http(s) URL")


def _normalise_bbox(bbox, w, h):
    """Take any common bbox shape and return [x1,y1,x2,y2] in 0..1 fractions."""
    if isinstance(bbox, str):
        bbox = ast.literal_eval(bbox)
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    vals = [float(v) for v in bbox]
    # Some engines return absolute pixels; if anything exceeds 1.5, scale.
    if max(vals) > 1.5 and w and h:
        vals = [vals[0] / w, vals[1] / h, vals[2] / w, vals[3] / h]
    return [round(min(1.0, max(0.0, v)), 4) for v in vals]


def _init_autogluon(model_dir):
    """Try AutoGluon ObjectDetector from model_dir. Raises on failure."""
    from autogluon.multimodal import ObjectDetector

    model = ObjectDetector.load(model_dir)

    def predict(image_bytes):
        from PIL import Image
        import tempfile

        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        w, h = img.size
        # AutoGluon predict accepts a path (or a PIL image on newer releases);
        # a temp file works on every release.
        with tempfile.NamedTemporaryFile(suffix=".png") as tmp:
            img.save(tmp.name)
            df = model.predict(tmp.name)
        out = []
        for _, row in df.iterrows():
            bbox = row.get("bbox") if "bbox" in df.columns else None
            if bbox is None:
                bbox = row.get("boxes") if "boxes" in df.columns else None
            label = None
            for col in ("labels", "class", "label"):
                if col in df.columns:
                    label = row.get(col)
                    break
            score = None
            for col in ("scores", "score", "confidence"):
                if col in df.columns:
                    score = row.get(col)
                    break
            label = label if label is not None else row.get("labels")
            if label is None or bbox is None:
                continue
            norm = _normalise_bbox(bbox, w, h)
            if not norm:
                continue
            # AutoGluon labels may be class indices; map through the model's
            # label list when available.
            if isinstance(label, (int, float)) and getattr(model, "classes", None):
                label = model.classes[int(label)]
            out.append({
                "class": str(label),
                "score": float(score) if score is not None else 1.0,
                "bbox": norm,
            })
        return out

    global _detector, _engine, _model_name, _class_names, _similarity
    _detector = predict
    _engine = "autogluon"
    _model_name = os.path.basename(model_dir.rstrip("/"))
    try:
        _class_names = list(getattr(model, "classes", None) or [])
    except Exception:
        _class_names = []
    # Similarity predictor, same library. Failure here only downgrades /similar.
    try:
        from autogluon.multimodal import MultiModalPredictor

        _similarity = MultiModalPredictor(
            problem_type="image_similarity",
            query=["query"],
            response=["response"],
        )
    except Exception as exc:  # noqa: BLE001 - reported on /health
        print("[detect] AutoGluon similarity predictor unavailable:", exc)


def _init_yolo(model_path):
    """Initialise ultralytics YOLO (opt-in). Raises on failure."""
    print("[detect]", AGPL_ULTRALYTICS_NOTICE)
    from ultralytics import YOLO

    model = YOLO(model_path)

    def predict(image_bytes):
        from PIL import Image

        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        w, h = img.size
        res = model.predict(img, conf=DETECT_CONF, verbose=False)[0]
        names = model.names or {}
        out = []
        for box in res.boxes:
            x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
            cls_id = int(box.cls[0])
            out.append({
                "class": str(names.get(cls_id, cls_id)),
                "score": round(float(box.conf[0]), 4),
                "bbox": [round(x1 / w, 4), round(y1 / h, 4), round(x2 / w, 4), round(y2 / h, 4)],
            })
        return out

    global _detector, _engine, _model_name, _class_names
    _detector = predict
    _engine = "ultralytics"
    _model_name = model_path
    _class_names = [str(v) for v in (model.names or {}).values()]


def _try_autogluon(model_dir):
    global _init_error
    try:
        _init_autogluon(model_dir)
        print("[detect] engine: AutoGluon ObjectDetector from", model_dir)
    except Exception as exc:
        _init_error = "AutoGluon init failed: %s" % exc
        print("[detect]", _init_error)
        traceback.print_exc()


def _try_yolo(model_path):
    global _init_error
    try:
        _init_yolo(model_path)
        print("[detect] engine: ultralytics YOLO, model", model_path)
    except Exception as exc:
        _init_error = "ultralytics init failed: %s" % exc
        print("[detect]", _init_error)
        traceback.print_exc()


def _init():
    global _init_error
    if _detector is not None:
        return
    engine = os.environ.get("DETECT_ENGINE", "auto").strip().lower()
    ag_model_dir = os.environ.get("AG_MODEL_DIR", "").strip()
    yolo_model = os.environ.get("YOLO_MODEL", "yolo11n.pt")

    if engine == "auto":
        if not ag_model_dir:
            _init_error = (
                "no detection engine configured: DETECT_ENGINE is 'auto' and "
                "AG_MODEL_DIR is not set. Point AG_MODEL_DIR at a trained "
                "AutoGluon ObjectDetector directory, or set "
                "DETECT_ENGINE=ultralytics to opt in to ultralytics YOLO."
            )
            print("[detect]", _init_error)
            return
        _try_autogluon(ag_model_dir)
        return
    if engine == "autogluon":
        _try_autogluon(ag_model_dir)
        return
    if engine == "ultralytics":
        _try_yolo(yolo_model)
        return
    _init_error = (
        "unknown DETECT_ENGINE %r (expected 'auto', 'autogluon', or 'ultralytics')"
        % engine
    )
    print("[detect]", _init_error)


def _has_cv2():
    try:
        import cv2  # noqa: F401

        return True
    except Exception:
        return False


@app.get("/health")
async def health():
    _init()
    return {
        "ok": _detector is not None,
        "engine": _engine,
        "model": _model_name,
        "classes": _class_names[:80],
        "similarity": (
            "autogluon" if _similarity is not None
            else ("heuristic" if _engine == "ultralytics" else None)
        ),
        "video": _has_cv2(),
        "error": _init_error,
    }


def _require_detector():
    _init()
    if _detector is None:
        raise HTTPException(status_code=503, detail=_init_error or "no detection engine")


class DetectBody(BaseModel):
    image: str


@app.post("/detect")
async def detect(body: DetectBody):
    """Detect objects in one image. Body: { image: url | data URL }."""
    _require_detector()
    try:
        raw = _load_image(body.image)
        return {"detections": _detector(raw), "engine": _engine}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail="detect failed: %s" % exc)


@app.post("/detect_upload")
async def detect_upload(file: UploadFile = File(...)):
    """Detect objects in an uploaded image (multipart, field 'file')."""
    _require_detector()
    try:
        raw = await file.read()
        return {"detections": _detector(raw), "engine": _engine}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail="detect failed: %s" % exc)


class VideoBody(BaseModel):
    url: str
    sample_every: Optional[int] = None


@app.post("/detect_video")
async def detect_video(body: VideoBody):
    """Sample frames from a video feed URL and detect on each sample."""
    _require_detector()
    if not re.match(r"^https?://", body.url):
        return {"error": "url must be http(s)"}
    try:
        import cv2
    except Exception:
        raise HTTPException(
            status_code=503,
            detail="opencv-python-headless is not installed (pip install -r detect/requirements.txt)",
        )
    step = body.sample_every or SAMPLE_EVERY_FRAMES
    started = time.time() * 1000
    frames = []
    cap = cv2.VideoCapture(body.url)
    try:
        if not cap.isOpened():
            raise RuntimeError("cannot open video feed (unsupported stream or format)")
        idx = 0
        while len(frames) < MAX_VIDEO_FRAMES:
            ok, frame = cap.read()
            if not ok:
                break
            idx += 1
            if idx % step != 0:
                continue
            ok2, buf = cv2.imencode(".jpg", frame)
            if not ok2:
                continue
            t_ms = cap.get(cv2.CAP_PROP_POS_MSEC) or 0
            frames.append({"t_ms": float(t_ms), "detections": _detector(buf.tobytes())})
    finally:
        cap.release()
    return {"frames": frames, "engine": _engine, "started_at_ms": started}


class Candidate(BaseModel):
    id: str
    image: str


class SimilarBody(BaseModel):
    query: str
    bbox: Optional[List[float]] = None
    candidates: List[Candidate]


def _ag_similar(query_bytes, bbox, candidates):
    """AutoGluon image_similarity ranking. Returns {'matches': [...], 'method'}."""
    from PIL import Image
    import pandas as pd

    q = Image.open(io.BytesIO(query_bytes)).convert("RGB")
    w, h = q.size
    if bbox:
        q = q.crop((bbox[0] * w, bbox[1] * h, bbox[2] * w, bbox[3] * h))
    rows = []
    for raw, cid in candidates:
        rows.append({
            "query": q,
            "response": Image.open(io.BytesIO(raw)).convert("RGB"),
            "id": cid,
        })
    df = _similarity.predict(pd.DataFrame(rows, columns=["query", "response", "id"]))
    col = "match_score" if "match_score" in df.columns else df.columns[-1]
    matches = [
        {"id": r["id"], "score": round(float(r[col]), 4)}
        for _, r in df.iterrows()
    ]
    matches.sort(key=lambda m: -m["score"])
    return {"matches": matches, "method": "autogluon"}


def _heuristic_similar(query_bytes, bbox, candidates):
    """Class-profile fallback: rank by overlap of detected class sets."""
    qd = _detector(query_bytes)
    qset = set(d["class"] for d in qd)
    if bbox is not None:
        # The crop should be dominated by the object itself; run detection on
        # the crop for a tighter profile.
        from PIL import Image

        img = Image.open(io.BytesIO(query_bytes)).convert("RGB")
        w, h = img.size
        crop = img.crop((bbox[0] * w, bbox[1] * h, bbox[2] * w, bbox[3] * h))
        buf = io.BytesIO()
        crop.save(buf, format="JPEG")
        qset = set(d["class"] for d in _detector(buf.getvalue())) or qset
    out = []
    for raw, cid in candidates:
        cset = set(d["class"] for d in _detector(raw))
        overlap = len(qset & cset)
        out.append({"id": cid, "score": round(overlap / max(1, len(qset)), 3)})
    out.sort(key=lambda m: -m["score"])
    return {"matches": out, "method": "heuristic"}


@app.post("/similar")
async def similar(body: SimilarBody):
    """'Find other instances of this': rank candidate images by similarity to
    the query image (optionally cropped to a detection bbox)."""
    _require_detector()
    try:
        query_bytes = _load_image(body.query)
        loaded = [(_load_image(c.image), c.id) for c in body.candidates]
    except Exception as exc:
        return {"error": "failed to load images: %s" % exc}
    if _similarity is not None:
        try:
            return _ag_similar(query_bytes, body.bbox, loaded)
        except Exception as exc:
            print("[detect] AutoGluon similarity failed, falling back to heuristic:", exc)
    if _engine == "ultralytics":
        return _heuristic_similar(query_bytes, body.bbox, loaded)
    raise HTTPException(
        status_code=503,
        detail="no similarity engine: AutoGluon is not available and the detector is not ultralytics",
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("DETECTION_PORT", "8770"))
    uvicorn.run(app, host="0.0.0.0", port=port)
