class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.accumulator = 0;
    this.sampleCount = 0;
    this.outBuffer = new Float32Array(4096); // ~256ms chunks at 16kHz
    this.outIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];
    for (let i = 0; i < channelData.length; i++) {
      this.accumulator += channelData[i];
      this.sampleCount++;

      if (this.sampleCount >= this.ratio) {
        this.outBuffer[this.outIndex++] = this.accumulator / this.sampleCount;
        this.accumulator = 0;
        this.sampleCount = 0;

        if (this.outIndex >= this.outBuffer.length) {
          const payload = this.outBuffer.slice(0);
          this.port.postMessage(payload.buffer, [payload.buffer]);
          this.outIndex = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-16k-processor", Pcm16kProcessor);