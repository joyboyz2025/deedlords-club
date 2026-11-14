# Narration for the demo film: one spoken line per caption, laid at the moment its caption appears.
#
#   python3 tools/demo/narrate.py <film.mp4> <out.mp4> [speed]
#
# The voice is made on this machine by a text-to-speech model behind an OpenAI-style endpoint (NARRATE_API, by default
# VoiceStudio's local server with its `mlx-audio` engine, the Kokoro-82M model). Nothing is sent anywhere else. The
# lines are written to NARRATE_DIR (a temporary folder by default) and kept, so a second run only mixes; REDO=1 makes
# them again. A line longer than the room before the next one is reported and nothing is mixed (FORCE=1 mixes anyway).
# The times below are those of the cut of 2026-11-14: after a scene is filmed again, read the new caption times off
# the film and change them here.
import json, subprocess, sys, urllib.request, os

import tempfile

API = os.environ.get("NARRATE_API", "http://127.0.0.1:3900/v1/audio/speech")
HERE = os.environ.get("NARRATE_DIR") or os.path.join(tempfile.gettempdir(), "deedlords-narration")
os.makedirs(HERE, exist_ok=True)
LINES = [
    (0.4, "Online games for money ask you to trust somebody's server."),
    (4.5, "Here, the dealer, the referee and the bank are NEAR contracts."),
    (10.7, "A guest gets a NEAR account in one tap. No wallet, no seed phrase."),
    (15.5, "The opponent is an AI model, running inside a hardware enclave."),
    (21.8, "The club opens the table on chain, and pays the guest's gas."),
    (27.6, "Every move is a transaction, and the contract rolls the dice."),
    (34.8, "No wallet pop-ups: a key that can only call the game signs each move."),
    (43.0, "The AI plays its whole turn in one transaction of its own."),
    (52.5, "Open the receipts. Every row is a real transaction."),
    (56.7, "This move is signed by the enclave the model ran in. Anyone can check it, in their own browser."),
    (68.3, "Poker, with no dealer."),
    (71.9, "Each seat shuffles the deck, and proves the shuffle in zero knowledge."),
    (76.7, "Your two cards are yours alone."),
    (80.9, "The contract holds the pot."),
    (83.7, "What the AI thinks stays sealed until the hand is over."),
    (88.2, "A card turns only when every seat gives its share of the key."),
    (102.3, "The hand is over. The contract pays the pot, and the AI's thoughts are opened."),
    (108.1, "All of it is live on NEAR mainnet."),
    (111.4, "A full shuffle, fifty-two encrypted cards and their proof, is one transaction."),
    (116.1, "Don't trust the film. One command checks every claim against mainnet."),
    (125.6, "Play free in ten seconds, or stake real NEAR."),
    (131.6, "Deedlords Club. No dealer. No game server. No wallet pop-ups."),
]


def say(text, path, speed):
    body = json.dumps({"model": "mlx-audio", "input": text, "voice": "default", "response_format": "wav", "language": "en", "speed": speed}).encode()
    req = urllib.request.Request(API, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=240) as r, open(path, "wb") as f:
        f.write(r.read())


def seconds(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    return float(out.strip())


def main():
    film, out = sys.argv[1], sys.argv[2]
    speed = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    clips, late = [], 0
    for i, (at, text) in enumerate(LINES):
        path = os.path.join(HERE, "line-%02d.wav" % i)
        if not os.path.exists(path) or os.environ.get("REDO"):
            say(text, path, speed)
        length = seconds(path)
        room = (LINES[i + 1][0] if i + 1 < len(LINES) else seconds(film)) - at
        flag = "" if length <= room - 0.15 else "  <-- runs %.1f s into the next line" % (length - room)
        late += bool(flag)
        print("%6.1f  %4.1f s of %4.1f  %s%s" % (at, length, room, text[:60], flag))
        clips.append((at, path))
    if late and not os.environ.get("FORCE"):
        print("%d lines too long: not mixed" % late)
        return 1
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", film]
    parts = []
    for i, (at, path) in enumerate(clips):
        cmd += ["-i", path]
        parts.append("[%d:a]aresample=48000,adelay=%d:all=1[a%d]" % (i + 1, int(at * 1000), i))
    mix = "".join("[a%d]" % i for i in range(len(clips)))
    parts.append("%samix=inputs=%d:normalize=0,alimiter=limit=0.9,apad[voice]" % (mix, len(clips)))
    cmd += ["-filter_complex", ";".join(parts), "-map", "0:v", "-map", "[voice]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True)
    print("wrote", out, "%.1f s" % seconds(out))
    return 0


sys.exit(main())
