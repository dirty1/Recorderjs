import InlineWorker from 'inline-worker';

export class Recorder {
    defaultConfig = {
        bufferLen: 4096,
        numChannels: 2,
        sampleRate: 44100,
        mimeType: 'audio/wav'
    }

    config = {};

    recording = false;

    callbacks = {
        getBuffer: [],
        exportWAV: []
    };

    constructor(source, cfg) {
        this.config = Object.assign({}, this.defaultConfig, cfg);

        this.context = source.context;
        this.node = (this.context.createScriptProcessor ||
        this.context.createJavaScriptNode).call(this.context,
            this.config.bufferLen, this.config.numChannels, this.config.numChannels);

        this.node.onaudioprocess = (e) => {
            if (!this.recording) return;

            var buffer = [];
            for (var channel = 0; channel < this.config.numChannels; channel++) {
                buffer.push(e.inputBuffer.getChannelData(channel));
            }
            this.worker.postMessage({
                command: 'record',
                buffer: buffer
            });
        };

        source.connect(this.node);
        this.node.connect(this.context.destination);    //this should not be necessary

        let self = {};
        this.worker = new InlineWorker(function () {
            let recLength = 0,
                recBuffers = [],
                sampleRate,
                numChannels;

            this.onmessage = function (e) {
                switch (e.data.command) {
                    case 'init':
                        init(e.data.config);
                        break;
                    case 'record':
                        record(e.data.buffer);
                        break;
                    case 'exportWAV':
                        exportWAV(e.data.type, e.data.buffer, e.data.sampleRate);
                        break;
                    case 'getBuffer':
                        getBuffer();
                        break;
                    case 'clear':
                        clear();
                        break;
                }
            };

            function init(config) {
                sampleRate = config.sampleRate;
                numChannels = config.numChannels;
                initBuffers();
            }

            function record(inputBuffer) {
                for (var channel = 0; channel < numChannels; channel++) {
                    recBuffers[channel].push(inputBuffer[channel]);
                }
                recLength += inputBuffer[0].length;
            }


            function _internalGetBuffers() {
                let buffers = [];
                for (let channel = 0; channel < numChannels; channel++) {
                    buffers.push(mergeBuffers(recBuffers[channel], recLength));
                }
                return buffers;
            }

            function exportWAV(type, buffers, sampleRate) {
                buffers = buffers || _internalGetBuffers();
                let interleaved;
                channels = buffers.length;

                if (channels === 2) {
                    interleaved = interleave(buffers[0], buffers[1]);
                } else {
                    interleaved = buffers[0];
                }

                let dataview = encodeWAV(interleaved, sampleRate);
                let audioBlob = new Blob([dataview], {type: type});

                this.postMessage({command: 'exportWAV', data: audioBlob});
            }

            function getBuffer() {
                let buffers = _internalGetBuffers();
                this.postMessage({command: 'getBuffer', data: buffers});
            }

            function clear() {
                recLength = 0;
                recBuffers = [];
                initBuffers();
            }

            function initBuffers() {
                for (let channel = 0; channel < numChannels; channel++) {
                    recBuffers[channel] = [];
                }
            }

            function mergeBuffers(recBuffers, recLength) {
                let result = new Float32Array(recLength);
                let offset = 0;
                for (let i = 0; i < recBuffers.length; i++) {
                    result.set(recBuffers[i], offset);
                    offset += recBuffers[i].length;
                }
                return result;
            }

            function interleave(inputL, inputR) {
                let length = inputL.length + inputR.length;
                let result = new Float32Array(length);

                let index = 0,
                    inputIndex = 0;

                while (index < length) {
                    result[index++] = inputL[inputIndex];
                    result[index++] = inputR[inputIndex];
                    inputIndex++;
                }
                return result;
            }

            function floatTo16BitPCM(output, offset, input) {
                for (let i = 0; i < input.length; i++, offset += 2) {
                    let s = Math.max(-1, Math.min(1, input[i]));
                    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                }
            }

            function writeString(view, offset, string) {
                for (let i = 0; i < string.length; i++) {
                    view.setUint8(offset + i, string.charCodeAt(i));
                }
            }

            function encodeWAV(samples, sampleRate) {
                let buffer = new ArrayBuffer(44 + samples.length * 2);
                let view = new DataView(buffer);

                /* RIFF identifier */
                writeString(view, 0, 'RIFF');
                /* RIFF chunk length */
                view.setUint32(4, 36 + samples.length * 2, true);
                /* RIFF type */
                writeString(view, 8, 'WAVE');
                /* format chunk identifier */
                writeString(view, 12, 'fmt ');
                /* format chunk length */
                view.setUint32(16, 16, true);
                /* sample format (raw) */
                view.setUint16(20, 1, true);
                /* channel count */
                view.setUint16(22, numChannels, true);
                /* sample rate */
                view.setUint32(24, sampleRate, true);
                /* byte rate (sample rate * block align) */
                view.setUint32(28, sampleRate * 4, true);
                /* block align (channel count * bytes per sample) */
                view.setUint16(32, numChannels * 2, true);
                /* bits per sample */
                view.setUint16(34, 16, true);
                /* data chunk identifier */
                writeString(view, 36, 'data');
                /* data chunk length */
                view.setUint32(40, samples.length * 2, true);

                floatTo16BitPCM(view, 44, samples);

                return view;
            }
        }, self);

        this.worker.postMessage({
            command: 'init',
            config: {
                sampleRate: this.context.sampleRate,
                numChannels: this.config.numChannels
            }
        });

        this.worker.onmessage = (e) => {
            let cb = this.callbacks[e.data.command] && this.callbacks[e.data.command].pop();
            if (typeof cb == 'function') {
                cb(e.data.data);
            }
        };

    }

    record() {
        this.recording = true;
    }

    stop() {
        this.recording = false;
    }

    clear() {
        this.worker.postMessage({command: 'clear'});
    }

    getBuffer(cb) {
        cb = cb || this.config.callback;
        if (!cb) throw new Error('Callback not set');

        // get record buffer from worker
        this.callbacks.getBuffer.push(function(buffer) {
            // resample to output sample rate
            self.resample(buffer, self.context.sampleRate, self.config.sampleRate, cb);
        });
        this.worker.postMessage({command: 'getBuffer'});
    }

    exportWAV(cb, mimeType) {
        var self = this;
        // get record buffer from worker
        this.callbacks.getBuffer.push(function(buffer) {
            // resample to output sample rate
            self.resample(buffer, self.context.sampleRate, self.config.sampleRate, function(buffer) {
                // hand over data to worker for wav export
                self.callbacks.exportWAV.push(cb);
                self.worker.postMessage({
                    command: 'exportWAV',
                    type: mimeType || self.config.mimeType,
                    buffer: buffer,
                    sampleRate: self.config.sampleRate
                });
            })
        })
        this.worker.postMessage({command: 'getBuffer'});
    }

    /**
     * Resample using OfflineAudioContext
     */
    resample(inBuffer, inSampleRate, outSampleRate, callback) {

        // if no resampling is needed, just return the input buffer
        if (inSampleRate == outSampleRate) {
            callback(inBuffer);
            return;
        }

        var oac = new OfflineAudioContext(inBuffer.length, inBuffer[0].length, outSampleRate);

        // create audio buffer
        var sourceBuffer = oac.createBuffer(inBuffer.length, inBuffer[0].length, inSampleRate);

        // copy audio data to source buffer
        for (var channel = 0; channel < inBuffer.length; channel++) {
            sourceBuffer.copyToChannel(inBuffer[channel], channel, 0);
        }

        // create source from buffer and connect to destination
        var source = oac.createBufferSource();
        source.buffer = sourceBuffer;
        source.connect(oac.destination);
        source.start(0);
        oac.oncomplete = function(audiobuffer) {
            // when rendered, copy channel data to buffer
            var buffer = [];
            var len = Math.round(outSampleRate * inBuffer[0].length / inSampleRate);
            for (var channel = 0; channel < audiobuffer.renderedBuffer.numberOfChannels; channel++) {
            buffer[channel] = new Float32Array;
                buffer[channel] = audiobuffer.renderedBuffer.getChannelData(channel).slice(0,len);
            }

            callback(buffer);
        }

        oac.startRendering();
    }

    static
    forceDownload(blob, filename) {
        let url = (window.URL || window.webkitURL).createObjectURL(blob);
        let link = window.document.createElement('a');
        link.href = url;
        link.download = filename || 'output.wav';
        let click = document.createEvent("Event");
        click.initEvent("click", true, true);
        link.dispatchEvent(click);
    }
}

export default Recorder;
