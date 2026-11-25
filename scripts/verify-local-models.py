"""Load all shipped fashion model backends locally without submitting any task."""
import argparse
import importlib.util
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--runtime", required=True)
args = parser.parse_args()
runtime = Path(args.runtime)
source = Path(__file__).resolve().parent.parent / "runtime-assets" / "fashion_vision_analyzer.py"
spec = importlib.util.spec_from_file_location("luma_fashion_verification", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
model_root = runtime / "quick-cut" / "runtime" / "fashion-vision" / "models"
from transformers import CLIPModel, CLIPProcessor

model = CLIPModel.from_pretrained(str(model_root / "fashionclip"), local_files_only=True)
CLIPProcessor.from_pretrained(str(model_root / "fashionclip"), local_files_only=True)
del model
rtmpose = module.create_pose_inferencer(model_root, "cpu", "rtmpose")
if rtmpose is None:
    raise RuntimeError("RTMPose weights did not load")
del rtmpose
hrnet = module.create_pose_inferencer(model_root, "cpu", "mmpose")
if hrnet is None:
    raise RuntimeError("MMPose HRNet fallback weights did not load")
print(json.dumps({"fashionclip": True, "rtmpose": True, "hrnetFallback": True}))
