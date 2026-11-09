export class AudioIO {
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private mute?: GainNode;
  private nextTime = 0;
  private readonly playing = new Set<AudioBufferSourceNode>();
  private avatarSource?: MediaStreamAudioSourceNode;
  private avatarAnalyser?: AnalyserNode;
  private avatarMute?: GainNode;
  private avatarSamples?: Float32Array<ArrayBuffer>;

  get isPlaying(): boolean { return this.playing.size > 0; }

  async unlock(): Promise<void> {
    this.context ??= new AudioContext({ sampleRate: 24_000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.context.resume(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Audio is blocked. Click Connect coach directly in the browser to allow playback.")), 4000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async capture(stream: MediaStream, send: (audio: string) => void): Promise<void> {
    await this.unlock();
    const context = this.context!;
    if (context.sampleRate !== 24_000) throw new Error("This browser cannot capture 24 kHz voice audio.");
    await context.audioWorklet.addModule("/capture-worklet.js");
    this.source = context.createMediaStreamSource(stream);
    this.worklet = new AudioWorkletNode(context, "pcm-capture");
    this.worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const bytes = new Uint8Array(event.data);
      let raw = "";
      for (const byte of bytes) raw += String.fromCharCode(byte);
      send(btoa(raw));
    };
    this.mute = context.createGain();
    this.mute.gain.value = 0;
    this.source.connect(this.worklet).connect(this.mute).connect(context.destination);
  }
  stopCapture(): void {
    if (this.worklet) this.worklet.port.onmessage = null;
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.mute?.disconnect();
    this.source = undefined;
    this.worklet = undefined;
    this.mute = undefined;
  }
  play(base64: string): void {
    const context = this.context;
    if (!context) throw new Error("Audio output has not been initialized.");
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    if (!bytes.length || bytes.length % 2 !== 0) throw new Error("Invalid PCM audio output.");
    const buffer = context.createBuffer(1, bytes.length / 2, 24_000);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => this.playing.delete(source);
    this.playing.add(source);
    this.nextTime = Math.max(context.currentTime + 0.02, this.nextTime);
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
  }
  stopPlayback(): void {
    for (const source of this.playing) source.stop();
    this.playing.clear();
    this.nextTime = 0;
  }
  monitorAvatar(stream: MediaStream): void {
    const context = this.context;
    if (!context) throw new Error("Audio output has not been initialized.");
    this.stopAvatarMonitor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(analyser).connect(mute).connect(context.destination);
    this.avatarSource = source;
    this.avatarAnalyser = analyser;
    this.avatarMute = mute;
    this.avatarSamples = new Float32Array(analyser.fftSize);
  }
  avatarLevel(): number | undefined {
    if (!this.avatarAnalyser || !this.avatarSamples) return undefined;
    this.avatarAnalyser.getFloatTimeDomainData(this.avatarSamples);
    let energy = 0;
    for (const sample of this.avatarSamples) energy += sample * sample;
    return Math.sqrt(energy / this.avatarSamples.length);
  }
  stopAvatarMonitor(): void {
    this.avatarSource?.disconnect();
    this.avatarAnalyser?.disconnect();
    this.avatarMute?.disconnect();
    this.avatarSource = undefined;
    this.avatarAnalyser = undefined;
    this.avatarMute = undefined;
    this.avatarSamples = undefined;
  }
  async close(): Promise<void> {
    this.stopCapture();
    this.stopPlayback();
    this.stopAvatarMonitor();
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== "closed") await context.close();
  }
}
