"""Chatterbox TTS (MIT, Resemble AI) behind a tiny HTTP API for DungeonMind's :full image.

POST /speak {"text": "...", "voice": "bm_fable", "speed": 1.0}  ->  audio/wav
A voice is a reference clip /data/voices/<voice>.wav (DungeonMind makes these with Kokoro, or you add your own).
"""
import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
import torchaudio as ta
from chatterbox.tts import ChatterboxTTS

DEVICE = os.environ.get("CHATTERBOX_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
VOICES = os.environ.get("CHATTERBOX_VOICES", "/data/voices")
model = ChatterboxTTS.from_pretrained(device=DEVICE)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "device": DEVICE}).encode())

    def do_POST(self):
        if self.path != "/speak":
            self.send_response(404)
            self.end_headers()
            return
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        text = str(body.get("text", ""))[:1000]
        voice = os.path.basename(str(body.get("voice", "")))
        ref = os.path.join(VOICES, f"{voice}.wav")
        try:
            wav = model.generate(text, audio_prompt_path=ref if os.path.exists(ref) else None, exaggeration=float(body.get("exaggeration", 0.5)))
            buf = io.BytesIO()
            ta.save(buf, wav, model.sr, format="wav")
            data = buf.getvalue()
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # noqa: BLE001
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("CHATTERBOX_PORT", "4831"))), Handler).serve_forever()
