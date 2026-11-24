import createPffftModule from './pffft-wasm.js';
const PFFFT_FORWARD = 0;
const PFFFT_BACKWARD = 1;
const PFFFT_REAL = 0;
const ZERO_BINS = 3;
export class PffftSTFT {
    nFft;
    hopLength;
    dimF;
    static modulePromise = null;
    mod;
    setup = 0;
    inPtr = 0;
    outPtr = 0;
    workPtr = 0;
    hannWindow;
    frameScratch;
    normEnvelopeCache = new Map();
    constructor(nFft, hopLength, dimF){
        if (nFft % 32 !== 0) {
            throw new Error(`PffftSTFT: nFft (${nFft}) must be a multiple of 32 (pffft real-transform requirement)`);
        }
        this.nFft = nFft;
        this.hopLength = hopLength;
        this.dimF = dimF;
        this.hannWindow = new Float32Array(nFft);
        for(let i = 0; i < nFft; i++){
            this.hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / nFft));
        }
        this.frameScratch = new Float32Array(nFft);
    }
    async init() {
        if (!PffftSTFT.modulePromise) {
            PffftSTFT.modulePromise = createPffftModule();
        }
        this.mod = await PffftSTFT.modulePromise;
        this.setup = this.mod._pffft_new_setup(this.nFft, PFFFT_REAL);
        if (this.setup === 0) {
            throw new Error(`PffftSTFT: pffft_new_setup(${this.nFft}, PFFFT_REAL) failed (returned NULL)`);
        }
        const nBytes = this.nFft * 4;
        this.inPtr = this.mod._pffft_aligned_malloc(nBytes);
        this.outPtr = this.mod._pffft_aligned_malloc(nBytes);
        this.workPtr = this.mod._pffft_aligned_malloc(nBytes);
        if (!this.inPtr || !this.outPtr || !this.workPtr) {
            throw new Error('PffftSTFT: pffft_aligned_malloc failed');
        }
        const simdArch = this.simdArchString();
        console.info(`pffft wasm FFT ready (simd_arch=${simdArch})`);
    }
    simdArchString() {
        const ptr = this.mod._pffft_simd_arch();
        const bytes = this.mod.HEAPU8;
        let s = '';
        for(let i = ptr; bytes[i] !== 0; i++)s += String.fromCharCode(bytes[i]);
        return s;
    }
    dimTFor(chunkSize) {
        const pad = this.nFft / 2;
        return Math.floor((chunkSize + 2 * pad - this.nFft) / this.hopLength) + 1;
    }
    reflectPadInto(src, srcOffset, n, pad, dst, dstOffset) {
        for(let i = 0; i < pad; i++){
            dst[dstOffset + i] = src[srcOffset + pad - i];
        }
        for(let i = 0; i < n; i++){
            dst[dstOffset + pad + i] = src[srcOffset + i];
        }
        for(let i = 0; i < pad; i++){
            dst[dstOffset + pad + n + i] = src[srcOffset + n - 2 - i];
        }
    }
    forward(batchData, batch, chunkSize) {
        const { nFft, hopLength, dimF } = this;
        if (chunkSize % hopLength !== 0) {
            throw new Error(`PffftSTFT.forward: chunkSize (${chunkSize}) must be an exact multiple of hopLength (${hopLength})`);
        }
        const pad = nFft / 2;
        const dimT = this.dimTFor(chunkSize);
        const paddedLength = chunkSize + 2 * pad;
        const out = new Float32Array(batch * 4 * dimF * dimT);
        const padded = new Float32Array(paddedLength);
        const heap = this.mod.HEAPF32;
        const inIdx = this.inPtr >> 2;
        const outIdx = this.outPtr >> 2;
        for(let b = 0; b < batch; b++){
            for(let ch = 0; ch < 2; ch++){
                const srcOffset = (b * 2 + ch) * chunkSize;
                this.reflectPadInto(batchData, srcOffset, chunkSize, pad, padded, 0);
                const reChanIdx = 2 * ch + 0;
                const imChanIdx = 2 * ch + 1;
                const reBase = (b * 4 + reChanIdx) * dimF * dimT;
                const imBase = (b * 4 + imChanIdx) * dimF * dimT;
                for(let t = 0; t < dimT; t++){
                    const frameStart = t * hopLength;
                    for(let i = 0; i < nFft; i++){
                        this.frameScratch[i] = padded[frameStart + i] * this.hannWindow[i];
                    }
                    heap.set(this.frameScratch, inIdx);
                    this.mod._pffft_transform_ordered(this.setup, this.inPtr, this.outPtr, this.workPtr, PFFFT_FORWARD);
                    const heapAfter = this.mod.HEAPF32;
                    for(let f = ZERO_BINS; f < dimF; f++){
                        let re;
                        let im;
                        if (f === 0) {
                            re = heapAfter[outIdx + 0];
                            im = 0;
                        } else {
                            re = heapAfter[outIdx + 2 * f];
                            im = heapAfter[outIdx + 2 * f + 1];
                        }
                        out[reBase + f * dimT + t] = re;
                        out[imBase + f * dimT + t] = im;
                    }
                }
            }
        }
        return out;
    }
    getNormEnvelope(dimT) {
        let env = this.normEnvelopeCache.get(dimT);
        if (env) return env;
        const { nFft, hopLength } = this;
        const paddedLength = (dimT - 1) * hopLength + nFft;
        env = new Float32Array(paddedLength);
        for(let t = 0; t < dimT; t++){
            const offset = t * hopLength;
            for(let i = 0; i < nFft; i++){
                const w = this.hannWindow[i];
                env[offset + i] += w * w;
            }
        }
        for(let i = 0; i < paddedLength; i++){
            env[i] += 1e-8;
        }
        this.normEnvelopeCache.set(dimT, env);
        return env;
    }
    inverse(specData, batch) {
        const { nFft, hopLength, dimF } = this;
        const pad = nFft / 2;
        const totalLen = specData.length;
        const dimT = totalLen / (batch * 4 * dimF);
        if (!Number.isInteger(dimT)) {
            throw new Error(`PffftSTFT.inverse: specData length (${totalLen}) not consistent with batch=${batch}, dimF=${dimF}`);
        }
        const paddedLength = (dimT - 1) * hopLength + nFft;
        const chunkSize = paddedLength - 2 * pad;
        const halfN = nFft / 2;
        const out = new Float32Array(batch * 2 * chunkSize);
        const accumulator = new Float32Array(paddedLength);
        const envelope = this.getNormEnvelope(dimT);
        const heap = this.mod.HEAPF32;
        const inIdx = this.inPtr >> 2;
        const outIdx = this.outPtr >> 2;
        for(let b = 0; b < batch; b++){
            for(let ch = 0; ch < 2; ch++){
                accumulator.fill(0);
                const reChanIdx = 2 * ch + 0;
                const imChanIdx = 2 * ch + 1;
                const reBase = (b * 4 + reChanIdx) * dimF * dimT;
                const imBase = (b * 4 + imChanIdx) * dimF * dimT;
                for(let t = 0; t < dimT; t++){
                    this.frameScratch.fill(0);
                    if (dimF > 0) {
                        this.frameScratch[0] = specData[reBase + 0 * dimT + t];
                    }
                    if (dimF > halfN) {
                        this.frameScratch[1] = specData[reBase + halfN * dimT + t];
                    }
                    const fMax = Math.min(dimF, halfN);
                    for(let f = 1; f < fMax; f++){
                        this.frameScratch[2 * f] = specData[reBase + f * dimT + t];
                        this.frameScratch[2 * f + 1] = specData[imBase + f * dimT + t];
                    }
                    heap.set(this.frameScratch, inIdx);
                    this.mod._pffft_transform_ordered(this.setup, this.inPtr, this.outPtr, this.workPtr, PFFFT_BACKWARD);
                    const heapAfter = this.mod.HEAPF32;
                    const frameStart = t * hopLength;
                    for(let i = 0; i < nFft; i++){
                        const sample = heapAfter[outIdx + i] / nFft * this.hannWindow[i];
                        accumulator[frameStart + i] += sample;
                    }
                }
                const dstOffset = (b * 2 + ch) * chunkSize;
                for(let i = 0; i < chunkSize; i++){
                    out[dstOffset + i] = accumulator[pad + i] / envelope[pad + i];
                }
            }
        }
        return out;
    }
}
