// Energy-based voice activity detection: turns a 16 kHz PCM16 stream into utterances.
// Each channel (you / them) gets its own Segmenter so speaker attribution comes for free.
export class Segmenter {
  constructor({
    sampleRate = 16000,
    frameMs = 20,
    minThreshold = 0.012,
    startFrames = 3,
    endSilenceMs = 750,
    minSpeechMs = 450,
    maxUtteranceMs = 20000,
    preRollMs = 250,
    onUtterance,
    onLevel,
  } = {}) {
    this.frameLen = Math.round((sampleRate * frameMs) / 1000);
    this.minThreshold = minThreshold;
    this.startFrames = startFrames;
    this.endSilenceFrames = Math.round(endSilenceMs / frameMs);
    this.minSpeechFrames = Math.round(minSpeechMs / frameMs);
    this.maxFrames = Math.round(maxUtteranceMs / frameMs);
    this.preRollFrames = Math.round(preRollMs / frameMs);
    this.onUtterance = onUtterance;
    this.onLevel = onLevel;
    this.noise = 0.004;
    this.pending = new Int16Array(0);
    this.gated = false;
    this.levelPeak = 0;
    this.levelCount = 0;
    this.reset();
  }

  reset() {
    this.preRoll = [];
    this.frames = [];
    this.inSpeech = false;
    this.loud = 0;
    this.silent = 0;
    this.speechFrames = 0;
  }

  setGate(on) {
    this.gated = on;
    if (on) this.reset();
  }

  push(int16) {
    const buf = new Int16Array(this.pending.length + int16.length);
    buf.set(this.pending);
    buf.set(int16, this.pending.length);
    let off = 0;
    while (off + this.frameLen <= buf.length) {
      this.frame(buf.subarray(off, off + this.frameLen));
      off += this.frameLen;
    }
    this.pending = buf.slice(off);
  }

  frame(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) {
      const v = f[i] / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / f.length);
    this.levelPeak = Math.max(this.levelPeak, rms);
    if (++this.levelCount >= 5) {
      this.onLevel?.(this.levelPeak);
      this.levelPeak = 0;
      this.levelCount = 0;
    }
    if (this.gated) return;

    const threshold = Math.max(this.minThreshold, this.noise * 3);
    const loud = rms > threshold;
    if (!this.inSpeech) {
      if (!loud) this.noise = this.noise * 0.995 + rms * 0.005;
      this.preRoll.push(f.slice());
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      if (loud && ++this.loud >= this.startFrames) {
        this.inSpeech = true;
        this.frames = this.preRoll;
        this.preRoll = [];
        this.speechFrames = this.loud;
        this.silent = 0;
      } else if (!loud) {
        this.loud = 0;
      }
      return;
    }
    this.frames.push(f.slice());
    if (loud) {
      this.silent = 0;
      this.speechFrames++;
    } else {
      this.silent++;
    }
    if (this.silent >= this.endSilenceFrames || this.frames.length >= this.maxFrames) this.finish();
  }

  /** Ends the current utterance now (push-to-talk release, stop listening). */
  flush() {
    if (this.inSpeech) this.finish();
  }

  finish() {
    const frames = this.frames;
    const speech = this.speechFrames;
    const trailing = Math.max(0, this.silent - 10);
    this.reset();
    if (speech < this.minSpeechFrames) return;
    const kept = frames.slice(0, frames.length - trailing);
    const total = kept.reduce((n, x) => n + x.length, 0);
    const out = new Int16Array(total);
    let o = 0;
    for (const x of kept) {
      out.set(x, o);
      o += x.length;
    }
    this.onUtterance?.(out);
  }
}
