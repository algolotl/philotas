# Philotas object detection service

The vision half of the VISION panel: a small FastAPI service that runs object
detection and image similarity for the Next.js app. The app reaches it through
DETECTION_URL (default http://127.0.0.1:8770).

## Engine selection

The detection engine is chosen by the DETECT_ENGINE environment variable:

- `auto` (default) - uses AutoGluon when AG_MODEL_DIR points at a trained
  model directory. When AG_MODEL_DIR is unset, the service reports an error and
  asks you to point AG_MODEL_DIR at a model (or opt in to ultralytics
  explicitly).
- `autogluon` - the AutoGluon ObjectDetector path (AG_MODEL_DIR).
- `ultralytics` - explicit opt-in to ultralytics YOLO (YOLO_MODEL, default
  yolo11n.pt).

## AutoGluon (supported default, Apache-2.0)

AutoGluon is the supported default engine. Install it and point AG_MODEL_DIR at
a trained model directory:

    python -m venv .venv
    .venv\Scripts\activate          # Windows
    pip install -r detect/requirements.txt
    pip install autogluon.multimodal
    python detect/train.py --data data/traffic/annotations.json --out models/traffic-v1
    $env:AG_MODEL_DIR = 'models/traffic-v1'      # PowerShell
    python detect/service.py

## ultralytics YOLO (opt-in, AGPL-3.0)

ultralytics is AGPL-3.0 licensed. It is not installed by default and is only
loaded when you explicitly set DETECT_ENGINE=ultralytics. Bring your own model
weights (YOLO_MODEL, default yolo11n.pt) and review the license before
operational use:

    pip install ultralytics
    $env:DETECT_ENGINE = 'ultralytics'           # PowerShell
    python detect/service.py

Never commit .pt model-weight files to the repository.

If no engine loads, every endpoint answers 503 and /health says why, so the
VISION panel degrades to a hint instead of an error.

## Endpoints

    GET  /health        engine, model, classes, video support
    POST /detect        { image: <url | data URL> } or multipart file upload
    POST /detect_video  { url, sample_every? }  -> { frames: [{t_ms, detections}] }
    POST /similar       { query, bbox?, candidates: [{id, image}] } -> { matches }

Detection rows are { class, score, bbox:[x1,y1,x2,y2] } with bbox normalised to
0-1 fractions of the image, which is what the map overlay and the VISION panel
expect.

## Environment

    DETECT_ENGINE         auto (default) | autogluon | ultralytics
    AG_MODEL_DIR          trained AutoGluon ObjectDetector directory
    YOLO_MODEL            ultralytics model (default yolo11n.pt)
    DETECT_CONF           confidence threshold (default 0.25)
    VIDEO_SAMPLE_EVERY    sample one frame every N (default 25)
    VIDEO_MAX_FRAMES      frames sampled per video call (default 40)
    DETECTION_PORT        port (default 8770)

## Notes

- /detect_video uses OpenCV's VideoCapture, which opens mp4 files and some
  streams directly. HLS (m3u8) and RTSP need a build of OpenCV with FFmpeg;
  opencv-python-headless usually has it on Windows.
- 'Find other instances' uses AutoGluon's image_similarity predictor when
  AutoGluon is present; under YOLO it falls back to a class-profile heuristic
  and labels the result method: heuristic.
- Train on the classes your workflows trigger on (person, bicycle, car...) so
  the built-in Traffic light accident watch fires on YOUR categories, not on
  COCO's 80.
