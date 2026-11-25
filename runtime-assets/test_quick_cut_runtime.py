"""Run with the isolated fashion-vision Python; no downloads or user writes."""
import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vision = load_module("fashion_vision_analyzer")
metadata = load_module("metadata_watermark_processor")


def box(kind, payload):
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


class MetadataScrubTests(unittest.TestCase):
    def test_scrubs_private_boxes_dates_and_compressor_without_moving_media(self):
        private = box(b"udta", box(b"meta", b"\0" * 4 + box(b"uuid", b"private-device-and-author")))
        header = box(b"mvhd", b"\0" * 4 + b"\x12" * 8 + b"\x01" * 20)
        video_entry = bytearray(90)
        video_entry[42:74] = b"encoder-software".ljust(32, b"\0")
        stsd = box(b"stsd", b"\0" * 4 + struct.pack(">I", 1) + box(b"avc1", video_entry))
        media = box(b"mdat", b"original-compressed-media\x01\x02")
        original = box(b"moov", header + private + stsd) + media
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "test.mp4"
            path.write_bytes(original)
            metadata._scrub_mp4_technical_tags(path)
            cleaned = path.read_bytes()
        self.assertEqual(len(cleaned), len(original))
        self.assertTrue(cleaned.endswith(media))
        self.assertNotIn(b"private-device-and-author", cleaned)
        self.assertNotIn(b"encoder-software", cleaned)
        self.assertNotIn(b"\x12" * 8, cleaned)


class VisionTests(unittest.TestCase):
    def test_sampling_is_bounded_and_stays_inside_short_and_long_shots(self):
        for duration in (0.05, 1, 3.5, 7, 30):
            times = vision.sample_times(5, 5 + duration)
            self.assertTrue(all(5 <= timestamp < 5 + duration for timestamp in times))
            self.assertLessEqual(len(times), 9)
        self.assertEqual(len(vision.sample_times(0, 3.5)), 5)

    def test_side_geometry_alone_cannot_override_front_visual_evidence(self):
        scores = dict.fromkeys(vision.ROLE_PROMPTS, 0.05)
        scores["wearing-effect"] = 0.4
        pose = {"available": True, "orientation": "side-back"}
        self.assertEqual(vision.apply_pose_evidence(scores, pose)["side-back"], 0.05)

    def test_motion_score_does_not_change_just_because_sampling_is_denser(self):
        def pose(timestamp):
            return {"timestamp": timestamp, "bodyHeight": 100, "visible": [0],
                    "points": [(timestamp * 10, 0)], "center": (timestamp * 10, 0)}
        sparse = vision.motion_strength([pose(0), pose(1.5), pose(3)])
        dense = vision.motion_strength([pose(index / 2) for index in range(7)])
        self.assertAlmostEqual(sparse, dense)

    def test_out_of_frame_keypoints_are_not_counted_as_complete_body(self):
        prediction = {"keypoints": [(50, 50)] * 5 + [(1000, 1000)] * 12,
                      "keypoint_scores": [0.9] * 17}
        pose = vision.normalize_prediction(prediction, (100, 100))
        self.assertEqual(pose["visible"], list(range(5)))
        self.assertEqual(pose["bodyFrame"], "partial")

    def test_cached_text_features_preserve_clip_scores(self):
        import numpy as np
        import torch
        from transformers import CLIPConfig, CLIPModel
        torch.manual_seed(42)
        config = CLIPConfig(
            text_config={"vocab_size": 32, "hidden_size": 16, "intermediate_size": 32,
                         "num_hidden_layers": 1, "num_attention_heads": 2, "max_position_embeddings": 8,
                         "bos_token_id": 0, "eos_token_id": 31},
            vision_config={"hidden_size": 16, "intermediate_size": 32, "num_hidden_layers": 1,
                           "num_attention_heads": 2, "image_size": 8, "patch_size": 4}, projection_dim=8)
        model = CLIPModel(config).eval()

        class Processor:
            def __call__(self, text=None, images=None, **kwargs):
                result = {}
                if text is not None:
                    result.update(input_ids=torch.arange(len(text)).unsqueeze(1).repeat(1, 4),
                                  attention_mask=torch.ones(len(text), 4, dtype=torch.long))
                if images is not None:
                    result["pixel_values"] = torch.stack([torch.tensor(np.array(image).copy()).permute(2, 0, 1).float() / 255 for image in images])
                return result

        processor = Processor()
        frames = [np.full((8, 8, 3), index * 10, dtype=np.uint8) for index in range(10)]
        reference = vision.fashion_scores(model, processor, frames, "cpu")
        scorer = vision.FashionScorer(model, processor, "cpu")
        actual = scorer.score(frames)
        for label in reference:
            self.assertAlmostEqual(reference[label], actual[label], places=5)
        self.assertEqual(scorer.image_batches, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
