// Downsamples the mic to 16 kHz mono PCM16 and posts ~100 ms frames to the main thread.
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.phase = 0;
    this.acc = 0;
    this.n = 0;
    this.out = new Int16Array(1600);
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.n++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.n));
        this.out[this.len++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.acc = 0;
        this.n = 0;
        if (this.len === this.out.length) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(1600);
          this.len = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("mic-capture", MicCapture);
