import {
  audioRms,
  END_SILENCE_SECONDS,
  joinAudioChunks,
  MAX_UTTERANCE_SECONDS,
  SPEECH_ACTIVITY_RMS,
  toWhisperSampleRate,
} from "./voiceCapture";

type WorkerMessage =
  | { type: "status"; text: string }
  | { type: "ready" }
  | { type: "transcript"; id: number; text: string }
  | { type: "error"; id?: number; message: string };

interface Recording {
  chunks: Float32Array[];
  totalSamples: number;
  voicedSamples: number;
  silentSamples: number;
}

/** Captures local microphone PCM and sends completed utterances to local Whisper. */
export class LocalMicrophone {
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private loaded = false;
  private resolveLoad: (() => void) | null = null;
  private rejectLoad: ((error: Error) => void) | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentOutput: GainNode | null = null;
  private preroll: Float32Array[] = [];
  private recording: Recording | null = null;
  private requestId = 0;
  private pendingRequestId: number | null = null;
  private generation = 0;
  private starting = false;
  private listening = false;
  private closed = false;

  constructor(
    private readonly onTranscript: (text: string) => void,
    private readonly onStatus: (text: string) => void,
    private readonly onListening: (value: boolean) => void,
  ) {}

  private handleWorkerMessage(message: WorkerMessage) {
    if (this.closed) return;
    if (message.type === "status") {
      this.onStatus(message.text);
    } else if (message.type === "ready") {
      this.loaded = true;
      this.resolveLoad?.();
      this.resolveLoad = null;
      this.rejectLoad = null;
    } else if (message.type === "error") {
      if (!this.loaded) {
        const error = new Error(message.message);
        this.rejectLoad?.(error);
        this.rejectLoad = null;
        this.resolveLoad = null;
        this.loading = null;
        this.worker?.terminate();
        this.worker = null;
      } else if (message.id === this.pendingRequestId) {
        this.pendingRequestId = null;
        this.onStatus("Could not transcribe speech: " + message.message);
      }
    } else if (message.id === this.pendingRequestId) {
      this.pendingRequestId = null;
      const transcript = message.text.trim();
      if (transcript && transcript !== "[BLANK_AUDIO]") {
        this.onTranscript(transcript);
      } else {
        this.onStatus("I didn't catch that. Listening again…");
        void this.start();
      }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = new Promise<void>((resolve, reject) => {
      this.resolveLoad = resolve;
      this.rejectLoad = reject;
      try {
        this.worker = new Worker(new URL("./localSpeech.worker.js", import.meta.url), {
          type: "module",
        });
        this.worker.onmessage = (event: MessageEvent<WorkerMessage>) =>
          this.handleWorkerMessage(event.data);
        this.worker.onerror = (event) => {
          const error = new Error(event.message || "Could not start local speech recognition");
          this.rejectLoad?.(error);
          this.rejectLoad = null;
          this.resolveLoad = null;
          this.loading = null;
          this.worker?.terminate();
          this.worker = null;
          if (this.loaded && !this.closed) this.onStatus(error.message);
        };
        this.worker.postMessage({ type: "load" });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.loading;
  }

  async start(): Promise<void> {
    if (this.closed || this.listening || this.starting || this.pendingRequestId !== null) return;
    const generation = ++this.generation;
    this.starting = true;
    let stream: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone capture is unavailable");
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (generation !== this.generation || this.closed) return;
      this.stream = stream;
      this.onStatus("Loading on-device speech recognition…");
      await this.ensureLoaded();
      if (generation !== this.generation || this.closed) return;
      const context = new AudioContext({ sampleRate: 16_000 });
      this.context = context;
      await context.resume();
      if (generation !== this.generation || this.closed) return;
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silentOutput = context.createGain();
      silentOutput.gain.value = 0;
      source.connect(processor);
      processor.connect(silentOutput);
      silentOutput.connect(context.destination);
      this.source = source;
      this.processor = processor;
      this.silentOutput = silentOutput;
      this.preroll = [];
      this.recording = null;
      processor.onaudioprocess = (event) => {
        if (this.listening) {
          this.receiveAudio(event.inputBuffer.getChannelData(0), context.sampleRate);
        }
      };
      this.listening = true;
      this.onListening(true);
      this.onStatus("Listening…");
    } catch (error) {
      if (generation === this.generation && !this.closed) {
        this.onStatus(error instanceof Error ? error.message : "Microphone failed");
        this.stop();
      }
    } finally {
      if (generation === this.generation) this.starting = false;
      if (stream && stream !== this.stream) {
        for (const track of stream.getTracks()) track.stop();
      }
    }
  }

  private receiveAudio(source: Float32Array, sampleRate: number): void {
    const chunk = new Float32Array(source);
    const voiced = audioRms(chunk) >= SPEECH_ACTIVITY_RMS;
    if (!this.recording) {
      this.preroll.push(chunk);
      const maxPreroll = sampleRate * 0.4;
      let prerollSamples = this.preroll.reduce((sum, part) => sum + part.length, 0);
      while (this.preroll.length > 1 && prerollSamples > maxPreroll) {
        prerollSamples -= this.preroll.shift()?.length ?? 0;
      }
      if (voiced) {
        this.recording = {
          chunks: [...this.preroll],
          totalSamples: prerollSamples,
          voicedSamples: chunk.length,
          silentSamples: 0,
        };
        this.preroll = [];
      }
      return;
    }
    const recording = this.recording;
    recording.chunks.push(chunk);
    recording.totalSamples += chunk.length;
    if (voiced) {
      recording.voicedSamples += chunk.length;
      recording.silentSamples = 0;
    } else {
      recording.silentSamples += chunk.length;
    }
    const duration = recording.totalSamples / sampleRate;
    const hasSpeech = recording.voicedSamples >= sampleRate * 0.2;
    const ended = recording.silentSamples >= sampleRate * END_SILENCE_SECONDS;
    if (
      (ended && hasSpeech && duration >= 0.7) ||
      duration >= MAX_UTTERANCE_SECONDS
    ) {
      if (!hasSpeech) {
        this.recording = null;
        return;
      }
      this.finishUtterance(sampleRate);
    }
  }

  private finishUtterance(sampleRate: number): void {
    const recording = this.recording;
    if (!recording || this.closed || this.pendingRequestId !== null) return;
    const pcm = toWhisperSampleRate(joinAudioChunks(recording.chunks), sampleRate);
    this.stopCapture();
    const id = ++this.requestId;
    this.pendingRequestId = id;
    this.onStatus("Transcribing locally…");
    this.worker?.postMessage({ type: "transcribe", id, audio: pcm }, [pcm.buffer]);
  }

  private stopCapture(): void {
    this.listening = false;
    this.onListening(false);
    this.recording = null;
    this.preroll = [];
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
    }
    this.source?.disconnect();
    this.silentOutput?.disconnect();
    this.processor = null;
    this.source = null;
    this.silentOutput = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.context) void this.context.close().catch(() => {});
    this.context = null;
  }

  stop(): void {
    this.generation++;
    this.starting = false;
    this.pendingRequestId = null;
    this.stopCapture();
  }

  close(): void {
    this.closed = true;
    this.stop();
    this.rejectLoad?.(new Error("Voice call ended"));
    this.rejectLoad = null;
    this.resolveLoad = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
