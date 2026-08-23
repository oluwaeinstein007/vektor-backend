# Test fixtures

`yolov8n.int8.onnx` — a real, functional INT8-quantized YOLOv8n ONNX model (COCO's 80 classes), produced by actually running `vektor-ml/cv-train-svc`'s real export pipeline (`export_int8_onnx`) against Ultralytics' pretrained `yolov8n.pt` weights. Verified loadable and runnable in `vektor-ml/cv-train-svc/tests/test_train_export_integration.py`.

It's checked in rather than generated at TS test time because `vektor-platform` and `vektor-ml` deliberately never share source, a filesystem, or a runtime (VEKTOR-PRD.md §9.3) — cv-inference-svc's tests can't shell out to Python to build one fresh without violating that boundary, and a real deployment gets its models as pre-built artifacts (from cv-train-svc, eventually via MinIO) anyway, not built alongside the consuming service. Every other real-infra fixture in this project's tests (RTSP streams, GeoTIFF files, AIVDM sentences) is generated fresh because doing so didn't cross that same boundary — this is the one deliberate exception, not a relaxation of the "verify against real, not mocked" rule: the model itself is completely real, just pre-built.

To regenerate: see `vektor-ml/cv-train-svc/README.md`, then `export_int8_onnx(Path("yolov8n.pt"), Path("./out"))`.

`synthetic-groundvehicle.int8.onnx` — a second real model, deliberately different from the first (single class, `imgsz=320` not 640), used to prove ML-006's hot-swap actually swaps rather than reloading the same file. It's the literal output of `vektor-ml/cv-train-svc/tests/test_train_export_integration.py`'s synthetic 4-image/1-epoch dataset — not meant to detect anything real, just a genuinely different model with a genuinely different input size and output shape than `yolov8n.int8.onnx`.
