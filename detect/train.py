"""
Train an AutoGluon object detector for Philotas.

Data: COCO-format JSON - { "images": [{"id","file_name"}], "annotations":
[{"image_id","bbox":[x,y,w,h],"category_id"}], "categories": [{"id","name"}] }.
AutoGluon's object_detection fit accepts exactly this shape.

Example:
    python detect/train.py --data data/traffic/annotations.json --out models/traffic-v1 --epochs 12

Then point the service at the result:
    set AG_MODEL_DIR=models/traffic-v1
    python detect/service.py

Training is GPU-friendly but runs on CPU too (slowly). Use a Python 3.10-3.12
environment; AutoGluon lags the newest Python releases.
"""

import argparse
import os


def main():
    parser = argparse.ArgumentParser(description="Train a Philotas object detector with AutoGluon")
    parser.add_argument("--data", required=True, help="COCO-format annotations JSON")
    parser.add_argument("--out", default="models/detector", help="model output directory")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--time-limit", type=int, default=None, help="AutoGluon time_limit seconds (overrides epochs)")
    args = parser.parse_args()

    from autogluon.multimodal import MultiModalPredictor

    predictor = MultiModalPredictor(problem_type="object_detection", label="labels")
    print("[train] fitting on", args.data)
    predictor.fit(
        train_data=args.data,
        hyperparameters={"optimization.max_epochs": args.epochs},
        time_limit=args.time_limit,
        presets="medium_quality",
    )
    os.makedirs(args.out, exist_ok=True)
    predictor.save(args.out)
    print("[train] saved model to", args.out)


if __name__ == "__main__":
    main()
