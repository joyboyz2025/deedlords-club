// Âm thanh tổng hợp bằng Web Audio, không cần tải file. Trình duyệt chỉ cho phát sau cú bấm đầu tiên.

import { readStored, writeStored } from "./storage";

const MUTE_KEY = "games:muted";

let context: AudioContext | null = null;
let muted = false;
let voice: SpeechSynthesisVoice | null = null;
let prepared = false;

/**
 * Chỉ trả về khi đang phát được. Nếu xếp tiếng vào lúc trình duyệt còn chặn,
 * tất cả sẽ phát dồn một lúc ngay khi người dùng chạm lần đầu.
 */
function audio(): AudioContext | null {
  if (muted || context?.state !== "running") return null;
  return context;
}

export function tone(frequency: number, at: number, duration: number, type: OscillatorType, peak: number): void {
  const ctx = audio();
  if (!ctx) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  const start = ctx.currentTime + at;
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

export function thump(at: number, duration: number, peak: number, cutoffHz: number): void {
  const ctx = audio();
  if (!ctx) return;
  const samples = Math.ceil(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, samples, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < samples; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / samples);
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  source.buffer = buffer;
  filter.type = "lowpass";
  filter.frequency.value = cutoffHz;
  gain.gain.value = peak;
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(ctx.currentTime + at);
}

function findVietnameseVoice(): void {
  voice = window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith("vi")) ?? null;
}

/** Máy không có giọng tiếng Việt thì im lặng, vì giọng khác đọc tiếng Việt nghe rất sai. */
export function speak(text: string): void {
  if (muted || !voice) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  writeStored(MUTE_KEY, value);
  if (value) window.speechSynthesis?.cancel();
}

/** Phải được gọi trong một cú bấm: iOS chỉ cho mở âm thanh và giọng đọc từ thao tác của người dùng. */
export function unlockSound(): void {
  context ??= new AudioContext();
  if (context.state === "running") return;
  void context.resume();
  if ("speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
}

/** Gọi khi màn hình chơi xuất hiện. */
export function prepareSound(): void {
  if (prepared) return;
  prepared = true;
  muted = readStored<boolean>(MUTE_KEY) ?? false;
  if ("speechSynthesis" in window) {
    findVietnameseVoice();
    window.speechSynthesis.addEventListener("voiceschanged", findVietnameseVoice);
  }
  // Tải lại trang giữa ván thì chưa có cú bấm nào. Vẫn lắng nghe sau đó vì iOS dừng âm thanh khi khóa máy.
  window.addEventListener("click", unlockSound);
}
