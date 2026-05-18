const SAFE_CAPACITY_H = [
    0, 7, 14, 26, 36, 46, 60, 66, 86, 100, 122, 140, 158, 180, 197, 220, 250, 
    280, 310, 338, 382, 403, 439, 461, 511, 535, 593, 625, 658, 698, 742, 790, 
    842, 898, 958, 983, 1051, 1093, 1139, 1219, 1273
];

class ColorScience {
    static srgbToLinear(c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    static writeHexToLinearRgb(hex, view, offset) {
        const num = parseInt(hex.substring(1), 16);
        view[offset] = this.srgbToLinear(((num >> 16) & 255) / 255.0);
        view[offset + 1] = this.srgbToLinear(((num >> 8) & 255) / 255.0);
        view[offset + 2] = this.srgbToLinear((num & 255) / 255.0);
    }

    static calculateContrastRatio(hex1, hex2) {
        const getLuminance = (h) => {
            const n = parseInt(h.substring(1), 16);
            const r = this.srgbToLinear(((n >> 16) & 255) / 255.0);
            const g = this.srgbToLinear(((n >> 8) & 255) / 255.0);
            const b = this.srgbToLinear((n & 255) / 255.0);
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const l1 = getLuminance(hex1);
        const l2 = getLuminance(hex2);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }
}

class WasmKernel {
    #module;
    #exports;
    #ctxPtr;
    #encoder;
    #decoder;
    
    #pool = {
        text: { ptr: 0, size: 0 },
        img: { ptr: 0, size: 0 }
    };

    #semanticBuffer;

    constructor() {
        this.#encoder = new TextEncoder();
        this.#decoder = new TextDecoder();
        this.#semanticBuffer = new Uint32Array(177 * 177); 
    }

    async initialize() {
        const wasiSinkhole = new Proxy({}, { get: () => () => 0 });
        const importObject = { wasi_snapshot_preview1: wasiSinkhole, env: wasiSinkhole };
        
        const wasmBytes = await (await fetch('transpiler.wasm')).arrayBuffer();
        this.#module = await WebAssembly.instantiate(wasmBytes, importObject);
        this.#exports = this.#module.instance.exports;
        
        this.#exports._initialize();
        this.#ctxPtr = this.#exports.create_context();
        if (!this.#ctxPtr) throw new Error("WASM Context Allocation Failure");
    }

    #getPtr(id, reqSize) {
        if (this.#pool[id].size < reqSize) {
            if (this.#pool[id].ptr) this.#exports.free_buffer(this.#pool[id].ptr);
            const newSize = Math.max(reqSize, this.#pool[id].size * 2, 4096);
            const ptr = this.#exports.allocate_buffer(newSize);
            if (ptr === 0) throw new Error("CRITICAL: WASM Memory Heap Exhaustion");
            this.#pool[id] = { ptr, size: newSize };
        }
        return this.#pool[id].ptr;
    }

    destroy() {
        if (this.#ctxPtr && this.#exports) {
            this.#exports.destroy_context(this.#ctxPtr);
            this.#ctxPtr = 0;
        }
    }

    #extractLuminance(rgbaData) {
        const size = rgbaData.length / 4;
        const luma = new Uint8Array(size);
        for(let i = 0; i < size; i++) {
            const idx = i << 2;
            luma[i] = (rgbaData[idx] * 54 + rgbaData[idx+1] * 183 + rgbaData[idx+2] * 19) >> 8;
        }
        return luma;
    }

    generateFromText(text, eccTier) {
        const bytes = this.#encoder.encode(text);
        const ptr = this.#getPtr('text', bytes.length);
        new Uint8Array(this.#exports.memory.buffer, ptr, bytes.length).set(bytes);
        
        const code = this.#exports.generate_qr_dynamic(this.#ctxPtr, ptr, bytes.length, eccTier);
        if (code !== 1) return null;
        return this.#extractState();
    }

    transpileImage(imgData, w, h) {
        const luma = this.#extractLuminance(imgData.data);
        const ptr = this.#getPtr('img', luma.length);
        new Uint8Array(this.#exports.memory.buffer, ptr, luma.length).set(luma);
        
        let code = this.#exports.transpile_qr(this.#ctxPtr, ptr, w, h, 0);
        if (code !== 1) code = this.#exports.transpile_qr(this.#ctxPtr, ptr, w, h, 1);
        
        const errorState = this.#exports.get_error_state(this.#ctxPtr);
        if (code !== 1) return { valid: false, errorState };
        
        const textPtr = this.#exports.get_decoded_text_ptr(this.#ctxPtr);
        const textLen = this.#exports.get_decoded_text_len(this.#ctxPtr);
        const decodedText = this.#decoder.decode(new Uint8Array(this.#exports.memory.buffer, textPtr, textLen));
        
        return { valid: true, text: decodedText, errorState, ...this.#extractState() };
    }

    validateImage(imgData, w, h) {
        const luma = this.#extractLuminance(imgData.data);
        const ptr = this.#getPtr('img', luma.length);
        new Uint8Array(this.#exports.memory.buffer, ptr, luma.length).set(luma);
        
        let code = this.#exports.validate_qr(this.#ctxPtr, ptr, w, h, 0);
        if (code !== 1) code = this.#exports.validate_qr(this.#ctxPtr, ptr, w, h, 1);
        
        const errorState = this.#exports.get_error_state(this.#ctxPtr);
        if (code !== 1) return { valid: false, errorState };
        
        const textPtr = this.#exports.get_decoded_text_ptr(this.#ctxPtr);
        const textLen = this.#exports.get_decoded_text_len(this.#ctxPtr);
        const text = this.#decoder.decode(new Uint8Array(this.#exports.memory.buffer, textPtr, textLen));
        
        return { valid: true, text, errorState };
    }

    #extractState() {
        const dimension = this.#exports.get_matrix_dimension(this.#ctxPtr);
        const matrixPtr = this.#exports.get_matrix_buffer(this.#ctxPtr);
        const raw8 = new Uint8Array(this.#exports.memory.buffer, matrixPtr, dimension * dimension);
        
        return {
            dimension,
            semanticPayload: this.#computeSemanticGrid(raw8, dimension),
            alignmentCenters: this.#computeAlignmentCenters(dimension)
        };
    }

    #computeAlignmentCenters(dim) {
        const version = (dim - 21) / 4 + 1;
        if (version < 2) return [];
        
        const numAlign = Math.floor(version / 7) + 2;
        const centers = [6];
        const last = version * 4 + 10;
        const step = Math.floor((last - 6 + Math.floor((numAlign - 1) / 2)) / (numAlign - 1)) & ~1;
        
        for (let i = numAlign - 2; i > 0; i--) centers.push(last - i * step);
        centers.push(last);
        
        let coords = [];
        for (const cx of centers) {
            for (const cy of centers) {
                if ((cx === 6 && cy === 6) || (cx === 6 && cy === dim - 7) || (cx === dim - 7 && cy === 6)) continue;
                coords.push({x: cx, y: cy});
            }
        }
        return coords;
    }

    #computeSemanticGrid(raw8, dim) {
        const payload32 = this.#semanticBuffer;
        const version = (dim - 21) / 4 + 1;
        const alignCenters = this.#computeAlignmentCenters(dim);

        for (let i = 0; i < dim * dim; i++) {
            payload32[i] = raw8[i];
        }

        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                payload32[y * dim + x] = 0;                   
                payload32[y * dim + (dim - 8 + x)] = 0;       
                payload32[(dim - 8 + y) * dim + x] = 0;       
            }
        }

        for (const c of alignCenters) {
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    payload32[(c.y + dy) * dim + (c.x + dx)] = 0;
                }
            }
        }

        for (let i = 8; i < dim - 8; i++) {
            payload32[6 * dim + i] = raw8[6 * dim + i] === 1 ? 2 : 0; 
            payload32[i * dim + 6] = raw8[i * dim + 6] === 1 ? 2 : 0; 
        }

        for (let i = 0; i <= 8; i++) {
            payload32[8 * dim + i] = raw8[8 * dim + i] === 1 ? 2 : 0;
            payload32[i * dim + 8] = raw8[i * dim + 8] === 1 ? 2 : 0;
        }
        for (let i = dim - 8; i < dim; i++) {
            payload32[8 * dim + i] = raw8[8 * dim + i] === 1 ? 2 : 0;
        }
        for (let i = dim - 7; i < dim; i++) {
            payload32[i * dim + 8] = raw8[i * dim + 8] === 1 ? 2 : 0;
        }

        if (version >= 7) {
            for (let y = 0; y <= 5; y++) {
                for (let x = dim - 11; x <= dim - 9; x++) {
                    payload32[y * dim + x] = raw8[y * dim + x] === 1 ? 2 : 0; 
                }
            }
            for (let y = dim - 11; y <= dim - 9; y++) {
                for (let x = 0; x <= 5; x++) {
                    payload32[y * dim + x] = raw8[y * dim + x] === 1 ? 2 : 0; 
                }
            }
        }

        return payload32;
    }
}

class GpuRenderer {
    #device;
    #context;
    
    #computePipeline;
    #renderPipeline;
    
    #buffers = { uniform: null, payload: null, align: null, voronoi: null };
    
    // Strict isolation of bindings resolving the Synchronization Scope crash
    #bindGroupCompute = null;
    #bindGroupRender = null;

    #uniformData;
    #uniformU32;
    #uniformF32;

    #valCanvas;
    #valCtx;

    #valTexture;
    #valReadBuffer;
    #valBytesPerRow;
    #valImageData;

    constructor() {
        this.#uniformData = new ArrayBuffer(80);
        this.#uniformU32 = new Uint32Array(this.#uniformData);
        this.#uniformF32 = new Float32Array(this.#uniformData);

        this.#valCanvas = ('OffscreenCanvas' in window) 
            ? new OffscreenCanvas(1024, 1024) 
            : document.createElement('canvas');
        this.#valCanvas.width = 1024;
        this.#valCanvas.height = 1024;
        this.#valCtx = this.#valCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
        this.#valImageData = new ImageData(1024, 1024);
    }

    async initialize(canvas) {
        const adapter = await navigator.gpu?.requestAdapter();
        if (!adapter) throw new Error("WebGPU Architecture Unsupported");
        
        this.#device = await adapter.requestDevice();
        this.#context = canvas.getContext('webgpu');
        this.#context.configure({
            device: this.#device,
            format: navigator.gpu.getPreferredCanvasFormat(),
            alphaMode: 'premultiplied'
        });

        const shaderCode = await (await fetch('engine.wgsl')).text();
        const shaderModule = this.#device.createShaderModule({ code: shaderCode });
        
        // AST Inference: We allow WebGPU to build the layouts natively from the shader entry points
        this.#computePipeline = await this.#device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: shaderModule, entryPoint: 'cs_voronoi' }
        });
        
        this.#renderPipeline = await this.#device.createRenderPipelineAsync({
            layout: 'auto',
            vertex: { module: shaderModule, entryPoint: 'vs_main' },
            fragment: { 
                module: shaderModule, 
                entryPoint: 'fs_main', 
                targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }]
            },
            primitive: { topology: 'triangle-list' }
        });
        
        this.#buffers.payload = this.#device.createBuffer({ size: 262144, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.#buffers.align = this.#device.createBuffer({ size: 4096, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.#buffers.uniform = this.#device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.#buffers.voronoi = this.#device.createBuffer({ size: 262144, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

        // Hermetic Compute BindGroup: Accesses ONLY the AST-inferred dependencies for cs_voronoi
        // Notice Binding 0 (payload) is purposefully absent, as it is dead code in the compute stage.
        this.#bindGroupCompute = this.#device.createBindGroup({
            layout: this.#computePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 1, resource: { buffer: this.#buffers.uniform } },
                { binding: 2, resource: { buffer: this.#buffers.align } },
                { binding: 3, resource: { buffer: this.#buffers.voronoi } }
            ]
        });

        // Hermetic Render BindGroup: Accesses ONLY the AST-inferred dependencies for fs_main
        // Notice Binding 3 (read_write) is absent, strictly honoring Fragment read-only safety.
        this.#bindGroupRender = this.#device.createBindGroup({
            layout: this.#renderPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.#buffers.payload } },
                { binding: 1, resource: { buffer: this.#buffers.uniform } },
                { binding: 2, resource: { buffer: this.#buffers.align } },
                { binding: 4, resource: { buffer: this.#buffers.voronoi } }
            ]
        });
    }

    configureContext(w, h) {
        if (!this.#context || !this.#device) return;
        this.#context.canvas.width = w;
        this.#context.canvas.height = h;
        this.#context.configure({
            device: this.#device,
            format: navigator.gpu.getPreferredCanvasFormat(),
            alphaMode: 'premultiplied'
        });
    }

    bindMatrixData(semanticPayload, dim, alignmentCenters) {
        this.#device.queue.writeBuffer(this.#buffers.payload, 0, semanticPayload.buffer, 0, dim * dim * 4);

        const alignData = new Float32Array(Math.max(2, alignmentCenters.length * 2));
        alignmentCenters.forEach((c, i) => { alignData[i*2] = c.x; alignData[i*2+1] = c.y; });
        this.#device.queue.writeBuffer(this.#buffers.align, 0, alignData);
    }

    #updateUniforms(config) {
        this.#uniformU32[0] = config.dimension;
        this.#uniformF32[1] = config.morphPayload;
        this.#uniformF32[2] = config.blendPayload;
        this.#uniformF32[3] = config.maskRadius;
        this.#uniformF32[4] = config.morphAnchor;
        this.#uniformU32[5] = config.alignCount;
        this.#uniformF32[6] = config.payloadScale;
        this.#uniformF32[7] = config.quietZone;

        ColorScience.writeHexToLinearRgb(config.colorPayload, this.#uniformF32, 8);
        this.#uniformU32[11] = config.themePayload;

        ColorScience.writeHexToLinearRgb(config.colorAnchor, this.#uniformF32, 12);
        this.#uniformU32[15] = config.themeAnchor;

        ColorScience.writeHexToLinearRgb(config.colorBg, this.#uniformF32, 16);

        this.#device.queue.writeBuffer(this.#buffers.uniform, 0, this.#uniformData);
    }

    async render(config) {
        if (!this.#bindGroupCompute || !this.#bindGroupRender) return;
        this.#updateUniforms(config);

        const encoder = this.#device.createCommandEncoder();
        
        const computePass = encoder.beginComputePass();
        computePass.setPipeline(this.#computePipeline);
        computePass.setBindGroup(0, this.#bindGroupCompute);
        const workgroups = Math.ceil(config.dimension / 16.0);
        computePass.dispatchWorkgroups(workgroups, workgroups, 1);
        computePass.end();

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.#context.getCurrentTexture().createView(),
                clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
                loadOp: 'clear', storeOp: 'store',
            }]
        });

        pass.setPipeline(this.#renderPipeline);
        pass.setBindGroup(0, this.#bindGroupRender);
        pass.draw(3, 1, 0, 0);
        pass.end();

        this.#device.queue.submit([encoder.finish()]);
    }

    async #extractRaster(config, targetRes) {
        if (!this.#bindGroupCompute || !this.#bindGroupRender) return null;
        this.#updateUniforms(config);

        const format = navigator.gpu.getPreferredCanvasFormat();
        let texture, readBuffer, bytesPerRow, imgData;

        if (targetRes === 1024) {
            if (!this.#valTexture) {
                this.#valTexture = this.#device.createTexture({
                    size: { width: 1024, height: 1024 },
                    format: format,
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
                });
                this.#valBytesPerRow = Math.ceil((1024 * 4) / 256) * 256;
                this.#valReadBuffer = this.#device.createBuffer({
                    size: this.#valBytesPerRow * 1024,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
                });
            }
            texture = this.#valTexture;
            readBuffer = this.#valReadBuffer;
            bytesPerRow = this.#valBytesPerRow;
            imgData = this.#valImageData;
        } else {
            texture = this.#device.createTexture({
                size: { width: targetRes, height: targetRes },
                format: format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
            });
            bytesPerRow = Math.ceil((targetRes * 4) / 256) * 256;
            readBuffer = this.#device.createBuffer({
                size: bytesPerRow * targetRes,
                usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
            });
            imgData = new ImageData(targetRes, targetRes);
        }

        const encoder = this.#device.createCommandEncoder();

        const computePass = encoder.beginComputePass();
        computePass.setPipeline(this.#computePipeline);
        computePass.setBindGroup(0, this.#bindGroupCompute);
        const workgroups = Math.ceil(config.dimension / 16.0);
        computePass.dispatchWorkgroups(workgroups, workgroups, 1);
        computePass.end();

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: texture.createView(),
                clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
                loadOp: 'clear', storeOp: 'store',
            }]
        });

        pass.setPipeline(this.#renderPipeline);
        pass.setBindGroup(0, this.#bindGroupRender);
        pass.draw(3, 1, 0, 0);
        pass.end();

        encoder.copyTextureToBuffer(
            { texture },
            { buffer: readBuffer, bytesPerRow: bytesPerRow, rowsPerImage: targetRes },
            { width: targetRes, height: targetRes }
        );

        this.#device.queue.submit([encoder.finish()]);
        await this.#device.queue.onSubmittedWorkDone();
        
        await readBuffer.mapAsync(GPUMapMode.READ);
        const src32 = new Uint32Array(readBuffer.getMappedRange());
        const dest32 = new Uint32Array(imgData.data.buffer);
        const pixelsPerRow = bytesPerRow / 4;

        if (format.includes('bgra')) {
            for (let y = 0; y < targetRes; y++) {
                let srcIdx = y * pixelsPerRow;
                let destIdx = y * targetRes;
                for (let x = 0; x < targetRes; x++) {
                    const pixel = src32[srcIdx++];
                    dest32[destIdx++] = (pixel & 0xff00ff00) | ((pixel & 0xff0000) >>> 16) | ((pixel & 0xff) << 16);
                }
            }
        } else {
            for (let y = 0; y < targetRes; y++) {
                dest32.set(src32.subarray(y * pixelsPerRow, y * pixelsPerRow + targetRes), y * targetRes);
            }
        }

        readBuffer.unmap();
        
        if (targetRes !== 1024) {
            texture.destroy();
            readBuffer.destroy();
        }

        return imgData;
    }

    async extractValidationRaster(config) {
        const imgData = await this.#extractRaster(config, 1024);
        if (!imgData) return null;

        this.#valCtx.putImageData(imgData, 0, 0);

        if (config.logoActive && config.logoBitmap) {
            const bmp = config.logoBitmap;
            const padding = config.quietZone * 2.0;
            const domainFraction = (config.logoScaleVal * 2.0 * config.dimension) / (config.dimension + padding);
            const logoBoxSize = domainFraction * 1024;

            this.#valCtx.save();
            this.#valCtx.imageSmoothingEnabled = true;
            this.#valCtx.imageSmoothingQuality = 'high';

            const imgRatio = bmp.width / bmp.height;
            let drawW = logoBoxSize;
            let drawH = logoBoxSize;

            if (imgRatio > 1.0) drawH = logoBoxSize / imgRatio;
            else if (imgRatio < 1.0) drawW = logoBoxSize * imgRatio;

            drawW = Math.round(drawW);
            drawH = Math.round(drawH);
            const dx = Math.round((1024 - drawW) / 2.0);
            const dy = Math.round((1024 - drawH) / 2.0);

            this.#valCtx.drawImage(bmp, dx, dy, drawW, drawH);
            this.#valCtx.restore();
        }

        return this.#valCtx.getImageData(0, 0, 1024, 1024);
    }

    async exportToCanvas(config, targetRes) {
        const imgData = await this.#extractRaster(config, targetRes);
        if (!imgData) return null;

        const canvas = ('OffscreenCanvas' in window) 
            ? new OffscreenCanvas(targetRes, targetRes) 
            : document.createElement('canvas');
            
        canvas.width = targetRes;
        canvas.height = targetRes;
        const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        ctx.putImageData(imgData, 0, 0);

        if (config.logoActive && config.logoBitmap) {
            const bmp = config.logoBitmap;
            const padding = config.quietZone * 2.0;
            const domainFraction = (config.logoScaleVal * 2.0 * config.dimension) / (config.dimension + padding);
            const logoBoxSize = domainFraction * targetRes;

            ctx.save();
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            const imgRatio = bmp.width / bmp.height;
            let drawW = logoBoxSize;
            let drawH = logoBoxSize;

            if (imgRatio > 1.0) drawH = logoBoxSize / imgRatio;
            else if (imgRatio < 1.0) drawW = logoBoxSize * imgRatio;

            drawW = Math.round(drawW);
            drawH = Math.round(drawH);
            const dx = Math.round((targetRes - drawW) / 2.0);
            const dy = Math.round((targetRes - drawH) / 2.0);

            ctx.drawImage(bmp, dx, dy, drawW, drawH);
            ctx.restore();
        }

        return canvas;
    }
}

class UiController {
    #kernel;
    #renderer;
    #dom;
    #state;
    #config;
    #timers;
    #blobRegistry;
    #boundRenderFrame;

    constructor(wasmKernel, gpuRenderer) {
        this.#kernel = wasmKernel;
        this.#renderer = gpuRenderer;
        
        this.#state = {
            dimension: 0,
            version: 1,
            eccTier: 1,
            alignCount: 0,
            renderScheduled: false,
            visualSize: 0,
            logoBitmap: null
        };

        this.#config = {
            dimension: 0,
            alignCount: 0,
            morphPayload: 2.0,
            blendPayload: 0.5,
            maskRadius: 0.0,
            morphAnchor: 2.0,
            payloadScale: 0.9,
            quietZone: 2.0,
            colorPayload: '#000000',
            colorAnchor: '#000000',
            colorBg: '#ffffff',
            themePayload: 0,
            themeAnchor: 0,
            logoActive: false,
            logoScaleVal: 0.0,
            logoBitmap: null
        };

        this.#timers = { text: null };
        this.#blobRegistry = { logo: null, input: null };
        this.#boundRenderFrame = this.#renderFrame.bind(this);
        
        this.#bindDomNodes();
        this.#attachListeners();
        lucide.createIcons();
    }

    #bindDomNodes() {
        this.#dom = {
            status: document.getElementById('status'),
            errorAlert: document.getElementById('error-alert'),
            errorMessage: document.getElementById('error-message'),
            fileInput: document.getElementById('file-input'),
            dropZone: document.getElementById('drop-zone'),
            uploadPrompt: document.getElementById('upload-prompt'),
            imagePreview: document.getElementById('image-preview'),
            imageContainer: document.getElementById('image-preview-container'),
            editorCard: document.getElementById('editor-card'),
            dataEditor: document.getElementById('data-editor'),
            payloadBadge: document.getElementById('payload-badge'),
            generatorCard: document.getElementById('generator-card'),
            gpuCanvas: document.getElementById('gpuCanvas'),
            placeholder: document.getElementById('output-placeholder'),
            ingestion: document.getElementById('ingestionCanvas'),
            validateBtn: document.getElementById('validate-btn'),
            validationStatus: document.getElementById('validation-status'),
            downloadBtn: document.getElementById('download-btn'),
            morphPayload: document.getElementById('paramMorphPayload'),
            morphAnchor: document.getElementById('paramMorphAnchor'),
            blendPayload: document.getElementById('paramBlendPayload'),
            mask: document.getElementById('paramMask'),
            logoScale: document.getElementById('paramLogoScale'),
            scalePayload: document.getElementById('paramScalePayload'),
            quietZone: document.getElementById('paramQuietZone'),
            colorPayload: document.getElementById('paramColorPayload'),
            colorAnchor: document.getElementById('paramColorAnchor'),
            colorBg: document.getElementById('paramColorBg'),
            themePayload: document.getElementById('paramThemePayload'),
            themeAnchor: document.getElementById('paramThemeAnchor'),
            contrastWarning: document.getElementById('contrast-warning'),
            logoInput: document.getElementById('logo-input'),
            logoOverlay: document.getElementById('logoOverlay'),
            removeLogoBtn: document.getElementById('remove-logo-btn')
        };
    }

    #attachListeners() {
        const ro = new ResizeObserver(entries => {
            for (let entry of entries) {
                const rect = entry.contentRect;
                this.#state.visualSize = Math.min(rect.width, rect.height);
                this.#dom.logoOverlay.style.width = `${this.#state.visualSize}px`;
                this.#dom.logoOverlay.style.height = `${this.#state.visualSize}px`;
                this.#updateLogoScaleTransformation();
            }
        });
        ro.observe(this.#dom.gpuCanvas.parentElement);

        this.#dom.dataEditor.addEventListener('input', (e) => {
            clearTimeout(this.#timers.text);
            this.#timers.text = setTimeout(() => this.#processTextIngestion(e.target.value), 250);
        });

        const syncLayoutParams = (param, value) => {
            document.getElementById(`val${param.charAt(0).toUpperCase() + param.slice(1)}`).textContent = value.toFixed(2);
        };

        this.#dom.mask.addEventListener('input', (e) => {
            syncLayoutParams('mask', parseFloat(e.target.value));
            this.#requestRender();
        });

        this.#dom.mask.addEventListener('change', () => this.#evaluateEccState());

        this.#dom.logoScale.addEventListener('input', (e) => {
            syncLayoutParams('logoScale', parseFloat(e.target.value));
            this.#updateLogoScaleTransformation();
            this.#requestRender();
        });

        this.#dom.logoScale.addEventListener('change', () => this.#evaluateEccState());

        ['morphPayload', 'morphAnchor', 'blendPayload', 'scalePayload', 'quietZone'].forEach(param => {
            this.#dom[param].addEventListener('input', (e) => {
                syncLayoutParams(param, parseFloat(e.target.value));
                if (param === 'quietZone') this.#updateLogoScaleTransformation();
                this.#requestRender();
            });
        });

        ['colorPayload', 'colorAnchor', 'colorBg'].forEach(param => {
            this.#dom[param].addEventListener('input', () => {
                this.#validateContrast();
                this.#requestRender();
            });
        });

        ['themePayload', 'themeAnchor'].forEach(param => {
            this.#dom[param].addEventListener('change', () => this.#requestRender());
        });

        this.#dom.logoInput.addEventListener('change', async (e) => {
            if (!e.target.files.length) return;
            this.#revokeBlob('logo');
            
            const file = e.target.files[0];
            this.#blobRegistry.logo = URL.createObjectURL(file);
            this.#dom.logoOverlay.src = this.#blobRegistry.logo;
            this.#dom.logoOverlay.setAttribute('data-active', 'true');
            
            if (this.#state.logoBitmap) this.#state.logoBitmap.close();
            this.#state.logoBitmap = await createImageBitmap(file);
            
            if (parseFloat(this.#dom.logoScale.value) === 0.0) {
                this.#dom.logoScale.value = 0.15;
                syncLayoutParams('logoScale', 0.15);
            }
            this.#updateLogoScaleTransformation();
            this.#evaluateEccState();
            this.#requestRender();
        });

        this.#dom.removeLogoBtn.addEventListener('click', () => {
            this.#revokeBlob('logo');
            this.#dom.logoOverlay.src = "";
            this.#dom.logoOverlay.removeAttribute('data-active');
            this.#dom.logoInput.value = "";
            
            if (this.#state.logoBitmap) {
                this.#state.logoBitmap.close();
                this.#state.logoBitmap = null;
            }
            
            this.#updateLogoScaleTransformation();
            this.#requestRender();
            this.#evaluateEccState();
        });

        this.#dom.fileInput.addEventListener('change', (e) => {
            if (e.target.files.length) this.#processImageIngestion(e.target.files[0]);
            e.target.value = '';
        });

        ['dragenter', 'dragover'].forEach(e => this.#dom.dropZone.addEventListener(e, ev => { 
            ev.preventDefault(); 
            this.#dom.dropZone.classList.add('drag-active'); 
        }));
        
        ['dragleave', 'drop'].forEach(e => this.#dom.dropZone.addEventListener(e, ev => { 
            ev.preventDefault(); 
            this.#dom.dropZone.classList.remove('drag-active'); 
        }));
        
        this.#dom.dropZone.addEventListener('drop', (e) => {
            if (e.dataTransfer.files.length) this.#processImageIngestion(e.dataTransfer.files[0]);
        });

        if (this.#dom.validateBtn) {
            this.#dom.validateBtn.addEventListener('click', () => this.#executeValidation());
        }

        if (this.#dom.downloadBtn) {
            this.#dom.downloadBtn.addEventListener('click', () => this.#executeExport());
        }
    }

    #revokeBlob(key) {
        if (this.#blobRegistry[key]) {
            URL.revokeObjectURL(this.#blobRegistry[key]);
            this.#blobRegistry[key] = null;
        }
    }

    #validateContrast() {
        const bg = this.#dom.colorBg.value;
        const pRatio = ColorScience.calculateContrastRatio(bg, this.#dom.colorPayload.value);
        const aRatio = ColorScience.calculateContrastRatio(bg, this.#dom.colorAnchor.value);
        
        if (pRatio < 3.0 || aRatio < 3.0) {
            this.#dom.contrastWarning.classList.remove('hidden');
        } else {
            this.#dom.contrastWarning.classList.add('hidden');
        }
    }

    #invalidateValidation() {
        if (this.#dom.validationStatus) {
            this.#dom.validationStatus.textContent = "Optical Integrity: Unverified";
            this.#dom.validationStatus.className = "text-sm font-mono font-medium text-gray-500";
        }
    }

    #calculateOptimalEcc() {
        const maskR = parseFloat(this.#dom.mask.value);
        const logoR = this.#dom.logoOverlay.getAttribute('data-active') === 'true' ? parseFloat(this.#dom.logoScale.value) : 0.0;
        const damageRadius = Math.max(maskR, logoR);
        
        if (damageRadius <= 0.0) return 1; 
        
        const damagePercentage = Math.PI * Math.pow(damageRadius, 2) * 100.0;
        const requiredRecovery = damagePercentage + 6.0;

        if (requiredRecovery <= 7.0) return 0;
        if (requiredRecovery <= 15.0) return 1;
        if (requiredRecovery <= 25.0) return 2;
        return 3;
    }

    #evaluateEccState() {
        const requiredEcc = this.#calculateOptimalEcc();
        if (requiredEcc !== this.#state.eccTier && this.#dom.dataEditor.value.trim()) {
            this.#processTextIngestion(this.#dom.dataEditor.value, requiredEcc);
        }
    }

    #updateLogoScaleTransformation() {
        if (!this.#state.dimension) return;
        
        const padding = parseFloat(this.#dom.quietZone.value) * 2.0;
        const logoScale = parseFloat(this.#dom.logoScale.value);
        const fraction = (logoScale * 2.0 * this.#state.dimension) / (this.#state.dimension + padding);
        
        this.#dom.logoOverlay.style.transform = `scale(${fraction})`;
        
        const isActive = this.#dom.logoOverlay.getAttribute('data-active') === 'true';
        if (fraction > 0 && isActive) {
            this.#dom.logoOverlay.classList.remove('hidden');
            this.#dom.removeLogoBtn.classList.remove('hidden');
        } else {
            this.#dom.logoOverlay.classList.add('hidden');
            this.#dom.removeLogoBtn.classList.add('hidden');
        }
    }

    #updateTelemetry(textLength) {
        const eccLabels = ["Low-ECC (7%)", "Med-ECC (15%)", "Quart-ECC (25%)", "High-ECC (30%)"];
        const maxBytes = SAFE_CAPACITY_H[this.#state.version] || '???';
        const percent = Math.min(100, Math.round((textLength / maxBytes) * 100));
        
        this.#dom.status.textContent = `V${this.#state.version} ${eccLabels[this.#state.eccTier]} | ${this.#state.dimension}x${this.#state.dimension} | Payload: ${textLength}/${maxBytes}B (${percent}%)`;
        this.#dom.status.className = 'text-sm font-mono font-medium text-blue-600';
    }

    #updateSemanticContext(text) {
        let type = "Text / Data", icon = "file-text";
        if (/^https?:\/\//i.test(text)) { type = "URL / Link"; icon = "link"; }
        else if (/^WIFI:/i.test(text)) { type = "WiFi Network"; icon = "wifi"; }
        else if (/^mailto:/i.test(text)) { type = "Email Address"; icon = "mail"; }
        else if (/^tel:/i.test(text)) { type = "Phone Number"; icon = "phone"; }
        else if (/^smsto:/i.test(text)) { type = "SMS Message"; icon = "message-square"; }
        else if (/^(BEGIN:VCARD|MECARD:)/i.test(text)) { type = "Contact Card"; icon = "contact"; }

        this.#dom.payloadBadge.innerHTML = `<i data-lucide="${icon}" class="w-3 h-3"></i> ${type}`;
        this.#dom.payloadBadge.classList.remove('hidden');
        lucide.createIcons();
    }

    #activateRenderer(qrState, textLength) {
        this.#dom.errorAlert.classList.add('hidden');
        this.#dom.generatorCard.classList.remove('opacity-50', 'pointer-events-none');
        this.#dom.gpuCanvas.classList.remove('hidden');
        this.#dom.placeholder.classList.add('hidden');

        this.#state.dimension = qrState.dimension;
        this.#state.version = (qrState.dimension - 21) / 4 + 1;
        this.#state.alignCount = qrState.alignmentCenters.length;
        
        this.#renderer.bindMatrixData(qrState.semanticPayload, qrState.dimension, qrState.alignmentCenters);
        
        this.#updateTelemetry(textLength);
        this.#updateLogoScaleTransformation();
        this.#requestRender();
    }

    #processTextIngestion(text, targetEcc = -1) {
        if (!text.trim()) {
            this.#dom.status.textContent = "System Ready";
            this.#dom.payloadBadge.classList.add('hidden');
            this.#invalidateValidation();
            return;
        }

        this.#state.eccTier = targetEcc !== -1 ? targetEcc : this.#calculateOptimalEcc();
        const qrState = this.#kernel.generateFromText(text, this.#state.eccTier);
        
        if (qrState) {
            this.#updateSemanticContext(text);
            this.#validateContrast();
            this.#activateRenderer(qrState, new TextEncoder().encode(text).length);
        } else {
            this.#dom.errorMessage.textContent = "Data overflow. Payload exceeds maximum capacity for current ECC tier.";
            this.#dom.errorAlert.classList.remove('hidden');
            this.#dom.status.textContent = "Encoding Failed";
            this.#dom.status.className = 'text-sm font-mono font-medium text-red-500';
            this.#invalidateValidation();
        }
    }

    async #processImageIngestion(file) {
        this.#dom.uploadPrompt.classList.add('hidden');
        this.#dom.imageContainer.classList.remove('hidden');
        
        this.#revokeBlob('input');
        this.#blobRegistry.input = URL.createObjectURL(file);
        this.#dom.imagePreview.src = this.#blobRegistry.input;

        const bitmap = await createImageBitmap(file);
        const MAX_DIM = 1024;
        let w = bitmap.width, h = bitmap.height;
        if (w > MAX_DIM || h > MAX_DIM) {
            const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
            w = Math.floor(w * ratio);
            h = Math.floor(h * ratio);
        }

        this.#dom.ingestion.width = w;
        this.#dom.ingestion.height = h;
        const ctx = this.#dom.ingestion.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close(); 
        
        this.#state.eccTier = 3; 
        const result = this.#kernel.transpileImage(ctx.getImageData(0, 0, w, h), w, h);
        
        if (result.valid) {
            this.#dom.dataEditor.value = result.text;
            this.#updateSemanticContext(result.text);
            this.#validateContrast();
            this.#activateRenderer(result, new TextEncoder().encode(result.text).length);
        } else {
            let errStr = "No valid QR field detected, or severe structural anomaly.";
            if (result.errorState === -4) errStr = "Data Integrity Checksum failed. Too much noise/distortion.";
            if (result.errorState === -2 || result.errorState === -3) errStr = "Structural anchors not found. Please ensure proper contrast.";
            
            this.#dom.errorMessage.textContent = errStr;
            this.#dom.errorAlert.classList.remove('hidden');
            this.#invalidateValidation();
        }
    }

    #updateConfigState() {
        this.#config.dimension = this.#state.dimension;
        this.#config.alignCount = this.#state.alignCount;
        this.#config.morphPayload = parseFloat(this.#dom.morphPayload.value);
        this.#config.blendPayload = parseFloat(this.#dom.blendPayload.value);
        this.#config.maskRadius = parseFloat(this.#dom.mask.value);
        this.#config.morphAnchor = parseFloat(this.#dom.morphAnchor.value);
        this.#config.payloadScale = parseFloat(this.#dom.scalePayload.value);
        this.#config.quietZone = parseFloat(this.#dom.quietZone.value);
        this.#config.colorPayload = this.#dom.colorPayload.value;
        this.#config.colorAnchor = this.#dom.colorAnchor.value;
        this.#config.colorBg = this.#dom.colorBg.value;
        this.#config.themePayload = parseInt(this.#dom.themePayload.value);
        this.#config.themeAnchor = parseInt(this.#dom.themeAnchor.value);
        this.#config.logoActive = this.#dom.logoOverlay.getAttribute('data-active') === 'true';
        this.#config.logoScaleVal = parseFloat(this.#dom.logoScale.value);
        this.#config.logoBitmap = this.#state.logoBitmap;
    }

    #renderFrame() {
        this.#renderer.render(this.#config);
        this.#state.renderScheduled = false;
    }

    #requestRender() {
        this.#invalidateValidation();
        this.#updateConfigState();
        if (!this.#state.renderScheduled && this.#state.dimension > 0) {
            this.#state.renderScheduled = true;
            requestAnimationFrame(this.#boundRenderFrame);
        }
    }

    async #executeValidation() {
        const text = this.#dom.dataEditor.value.trim();
        if (!text || this.#state.dimension === 0) return;

        this.#dom.validateBtn.disabled = true;
        this.#dom.validateBtn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Validating...`;
        lucide.createIcons();

        await new Promise(resolve => requestAnimationFrame(resolve));

        try {
            this.#updateConfigState();
            const imgData = await this.#renderer.extractValidationRaster(this.#config);
            if (!imgData) throw new Error("VRAM Extraction Failed");

            const result = this.#kernel.validateImage(imgData, 1024, 1024);

            if (result.valid && result.text === text) {
                this.#dom.validationStatus.textContent = "Optical Integrity: Verified";
                this.#dom.validationStatus.className = "text-sm font-mono font-bold text-green-600";
            } else {
                if (result.errorState === -4) {
                    this.#dom.validationStatus.textContent = "Optical Integrity: Checksum Failure (Reduce Blend/Volumetrics)";
                    this.#dom.validationStatus.className = "text-sm font-mono font-bold text-orange-500";
                } else if (result.errorState === -2 || result.errorState === -3) {
                    this.#dom.validationStatus.textContent = "Optical Integrity: Structural Failure (Check Morphology/Anchors)";
                    this.#dom.validationStatus.className = "text-sm font-mono font-bold text-red-500";
                } else {
                    this.#dom.validationStatus.textContent = "Optical Integrity: Critical Failure (Mismatch)";
                    this.#dom.validationStatus.className = "text-sm font-mono font-bold text-red-600";
                }
            }
        } catch (e) {
            this.#dom.validationStatus.textContent = "Optical Integrity: Compute Error";
            this.#dom.validationStatus.className = "text-sm font-mono font-bold text-red-600";
        } finally {
            this.#dom.validateBtn.disabled = false;
            this.#dom.validateBtn.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4"></i> Verify Integrity`;
            lucide.createIcons();
        }
    }

    async #executeExport() {
        const originalHtml = this.#dom.downloadBtn.innerHTML;
        this.#dom.downloadBtn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Rendering 4K...`;
        this.#dom.downloadBtn.disabled = true;
        lucide.createIcons();

        await new Promise(resolve => requestAnimationFrame(resolve));

        try {
            const TARGET_RES = 3840;
            this.#updateConfigState();
            const baseCanvas = await this.#renderer.exportToCanvas(this.#config, TARGET_RES);
            if (!baseCanvas) throw new Error("VRAM Mapping Pipeline Failed");

            let blob;
            if (baseCanvas instanceof OffscreenCanvas) {
                blob = await baseCanvas.convertToBlob({ type: "image/png", quality: 1.0 });
            } else {
                const dataUrl = baseCanvas.toDataURL("image/png", 1.0);
                blob = await (await fetch(dataUrl)).blob();
            }

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = `QR-Export-${Date.now()}.png`;
            link.href = url;
            link.click();
            
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            
        } catch (e) {
            this.#dom.errorMessage.textContent = "4K Export Failed: " + e.message;
            this.#dom.errorAlert.classList.remove('hidden');
        } finally {
            this.#dom.downloadBtn.innerHTML = originalHtml;
            this.#dom.downloadBtn.disabled = false;
            lucide.createIcons();
        }
    }

    startup() {
        this.#dom.editorCard.classList.remove('opacity-50', 'pointer-events-none');
        this.#dom.status.textContent = "System Ready";
    }
}

(async function() {
    const kernel = new WasmKernel();
    const renderer = new GpuRenderer();
    
    try {
        await Promise.all([
            kernel.initialize(),
            renderer.initialize(document.getElementById('gpuCanvas'))
        ]);
        
        const ui = new UiController(kernel, renderer);
        ui.startup();
        
    } catch (e) {
        document.getElementById('error-message').textContent = e.message;
        document.getElementById('error-alert').classList.remove('hidden');
        const status = document.getElementById('status');
        status.textContent = "Initialization Failed";
        status.className = 'text-sm font-mono font-medium text-red-500';
    }
})();