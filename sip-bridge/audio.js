/**
 * G.711 μ-law helpers + PCM resample + WAV pack for Whisper.
 */

const BIAS = 0x84;
const CLIP = 32635;
const MULAW_DECODE = new Int16Array(256);

(function initMulawDecode() {
  for (let i = 0; i < 256; i += 1) {
    let u = ~i;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + BIAS) << exponent;
    sample -= BIAS;
    MULAW_DECODE[i] = sign ? -sample : sample;
  }
})();

function linearToMulaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (sample >> (exponent === 0 ? 4 : exponent + 3)) & 0x0f;
  const mulaw = ~(sign | (exponent << 4) | mantissa);
  return mulaw & 0xff;
}

function mulawToLinear(byte) {
  return MULAW_DECODE[byte & 0xff];
}

/** Downsample Int16 PCM from srcRate to 8000 Hz and encode μ-law. */
function pcm16ToMulaw8k(pcm16, srcRate = 24000) {
  if (!pcm16.length) return Buffer.alloc(0);
  const ratio = srcRate / 8000;
  const outLen = Math.floor(pcm16.length / ratio);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const srcIndex = Math.min(pcm16.length - 1, Math.floor(i * ratio));
    out[i] = linearToMulaw(pcm16[srcIndex]);
  }
  return out;
}

function bufferToInt16LE(buf) {
  const samples = new Int16Array(buf.length / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buf.readInt16LE(i * 2);
  }
  return samples;
}

function silenceMulaw(ms = 200) {
  const samples = Math.floor(8000 * (ms / 1000));
  return Buffer.alloc(samples, 0xff);
}

/** Decode μ-law bytes to Int16 PCM (8 kHz). */
function mulawToPcm16(mulawBuf) {
  const out = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i += 1) {
    out.writeInt16LE(mulawToLinear(mulawBuf[i]), i * 2);
  }
  return out;
}

/** Frame energy (mean abs) for VAD on μ-law. */
function mulawFrameEnergy(frame) {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    sum += Math.abs(mulawToLinear(frame[i]));
  }
  return sum / frame.length;
}

/** Pack 8 kHz mono PCM16 into a WAV buffer for Whisper. */
function pcm16ToWav(pcm16, sampleRate = 8000) {
  const dataSize = pcm16.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm16]);
}

function mulawToWav(mulawBuf, sampleRate = 8000) {
  return pcm16ToWav(mulawToPcm16(mulawBuf), sampleRate);
}

module.exports = {
  linearToMulaw,
  mulawToLinear,
  pcm16ToMulaw8k,
  bufferToInt16LE,
  silenceMulaw,
  mulawToPcm16,
  mulawFrameEnergy,
  pcm16ToWav,
  mulawToWav,
};
