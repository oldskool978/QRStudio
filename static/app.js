const SAFE_CAPACITY_H = [
    0, 7, 14, 26, 36, 46, 60, 66, 86, 100, 122, 140, 158, 180, 197, 220, 250, 
    280, 310, 338, 382, 403, 439, 461, 511, 535, 593, 625, 658, 698, 742, 790, 
    842, 898, 958, 983, 1051, 1093, 1139, 1219, 1273
];

class ColorScience {
    static srgbToLinear(c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    static hexToLinearRgb(hex) {
        const r = parseInt(hex.slice(1, 3), 16) / 255.0;
        const g = parseInt(hex.slice(3, 5), 16) / 255.0;
        const b = parseInt(hex.slice(5, 7), 16) / 255.0;
        return [this.srgbToLinear(r), this.srgbToLinear(g), this.srgbToLinear(b)];
    }

    static getLuminance(r, g, b) {
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    static calculateContrastRatio(hex1, hex2) {
        const l1 = this.getLuminance(...this.hexToLinearRgb(hex1));
        const l2 = this.getLuminance(...this.hexToLinearRgb(hex2));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }
}

class WasmKernel {
    #module;
    #exports;
    #ctxPtr;

    async initialize() {
        const wasiSinkhole = new Proxy({}, { get: () => () => 0 });
        const importObject = { wasi_snapshot_preview1: wasiSinkhole, env: wasiSinkhole };
        
        const wasmBytes = await (await fetch('transpiler.wasm')).arrayBuffer();
        this.#module = await WebAssembly.instantiate(wasmBytes, importObject);
        this.#exports = this.#module.instance.exports;
        
        this.#exports._initialize();
        this.#ctxPtr = this.#exports.create_context();
        if (!this.#ctxPtr) throw new Error("WASM Allocation Failure");
    }

    destroy() {
        if (this.#ctxPtr && this.#exports) {
            this.#exports.destroy_context(this.#ctxPtr);
            this.#ctxPtr = 0;
        }
    }

    generateFromText(text, eccTier) {
        const bytes = new TextEncoder().encode(text);
        const ptr = this.#exports.allocate_buffer(bytes.length);
        new Uint8Array(this.#exports.memory.buffer, ptr, bytes.length).set(bytes);
        
        const code = this.#exports.generate_qr_dynamic(this.#ctxPtr, ptr, bytes.length, eccTier);
        this.#exports.free_buffer(ptr);
        
        if (code !== 1) return null;
        return this.#extractState();
    }

    transpileImage(imgData, w, h) {
        const ptr = this.#exports.allocate_buffer(imgData.data.length);
        new Uint8Array(this.#exports.memory.buffer, ptr, imgData.data.length).set(imgData.data);
        
        const code = this.#exports.transpile_qr(this.#ctxPtr, ptr, w, h);
        this.#exports.free_buffer(ptr);
        
        if (code !== 1) return null;
        
        const textPtr = this.#exports.get_decoded_text_ptr(this.#ctxPtr);
        const textLen = this.#exports.get_decoded_text_len(this.#ctxPtr);
        const decodedText = new TextDecoder().decode(new Uint8Array(this.#exports.memory.buffer, textPtr, textLen));
        
        return { text: decodedText, ...this.#extractState() };
    }

    validateImage(imgData, w, h) {
        const ptr = this.#exports.allocate_buffer(imgData.data.length);
        new Uint8Array(this.#exports.memory.buffer, ptr, imgData.data.length).set(imgData.data);
        
        const code = this.#exports.validate_qr(this.#ctxPtr, ptr, w, h);
        this.#exports.free_buffer(ptr);
        
        if (code !== 1) return null;
        
        const textPtr = this.#exports.get_decoded_text_ptr(this.#ctxPtr);
        const textLen = this.#exports.get_decoded_text_len(this.#ctxPtr);
        return new TextDecoder().decode(new Uint8Array(this.#exports.memory.buffer, textPtr, textLen));
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
        const payload32 = new Uint32Array(dim * dim);
        const version = (dim - 21) / 4 + 1;
        const alignCenters = this.#computeAlignmentCenters(dim);

        const isFinder = (x, y) => (x < 8 && y < 8) || (x >= dim - 8 && y < 8) || (x < 8 && y >= dim - 8);
        const isAlignment = (x, y) => alignCenters.some(c => Math.abs(x - c.x) <= 2 && Math.abs(y - c.y) <= 2);
        const isTiming = (x, y) => (x === 6 && y >= 8 && y < dim - 8) || (y === 6 && x >= 8 && x < dim - 8);
        const isFormat = (x, y) => (y === 8 && ((x >= 0 && x <= 8) || (x >= dim - 8 && x < dim))) || (x === 8 && ((y >= 0 && y <= 8) || (y >= dim - 7 && y < dim)));
        const isVersion = (x, y) => version >= 7 && ((x >= dim - 11 && x <= dim - 9 && y >= 0 && y <= 5) || (x >= 0 && x <= 5 && y >= dim - 11 && y <= dim - 9));

        for (let y = 0; y < dim; y++) {
            for (let x = 0; x < dim; x++) {
                const idx = y * dim + x;
                const val = raw8[idx];

                if (isFinder(x, y) || isAlignment(x, y)) {
                    payload32[idx] = 0; 
                } else if (isTiming(x, y) || isFormat(x, y) || isVersion(x, y)) {
                    payload32[idx] = val === 1 ? 2 : 0; 
                } else {
                    payload32[idx] = val === 1 ? 1 : 0; 
                }
            }
        }
        return payload32;
    }
}

class GpuRenderer {
    #device;
    #context;
    #renderPipeline;
    
    #buffers = {
        uniform: null,
        payload: null,
        align: null
    };
    #bindGroup = null;

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
        
        this.#buffers.uniform = this.#device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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

    bindMatrixData(semanticPayload, alignmentCenters) {
        if (this.#buffers.payload) this.#buffers.payload.destroy();
        this.#buffers.payload = this.#device.createBuffer({ size: semanticPayload.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.#device.queue.writeBuffer(this.#buffers.payload, 0, semanticPayload);

        const alignData = new Float32Array(Math.max(2, alignmentCenters.length * 2));
        alignmentCenters.forEach((c, i) => { alignData[i*2] = c.x; alignData[i*2+1] = c.y; });
        
        if (this.#buffers.align) this.#buffers.align.destroy();
        this.#buffers.align = this.#device.createBuffer({ size: alignData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        this.#device.queue.writeBuffer(this.#buffers.align, 0, alignData);

        this.#bindGroup = null; 
    }

    #ensureBindGroup() {
        if (!this.#bindGroup) {
            this.#bindGroup = this.#device.createBindGroup({
                layout: this.#renderPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.#buffers.payload } },
                    { binding: 1, resource: { buffer: this.#buffers.uniform } },
                    { binding: 2, resource: { buffer: this.#buffers.align } }
                ]
            });
        }
    }

    #updateUniforms(config) {
        const paramData = new ArrayBuffer(80);
        const paramU32 = new Uint32Array(paramData);
        const paramF32 = new Float32Array(paramData);
        
        paramU32[0] = config.dimension;
        paramF32[1] = config.morphPayload;
        paramF32[2] = config.blendPayload;
        paramF32[3] = config.maskRadius;
        paramF32[4] = config.morphAnchor;
        paramU32[5] = config.alignCount;
        paramF32[6] = config.payloadScale;
        paramF32[7] = config.quietZone;

        const rgbP = ColorScience.hexToLinearRgb(config.colorPayload);
        const rgbA = ColorScience.hexToLinearRgb(config.colorAnchor);
        const rgbB = ColorScience.hexToLinearRgb(config.colorBg);
        
        paramF32[8] = rgbP[0]; paramF32[9] = rgbP[1]; paramF32[10] = rgbP[2];
        paramU32[11] = config.themePayload;

        paramF32[12] = rgbA[0]; paramF32[13] = rgbA[1]; paramF32[14] = rgbA[2];
        paramU32[15] = config.themeAnchor;

        paramF32[16] = rgbB[0]; paramF32[17] = rgbB[1]; paramF32[18] = rgbB[2];

        this.#device.queue.writeBuffer(this.#buffers.uniform, 0, paramData);
    }

    async render(config) {
        if (!this.#buffers.payload || !this.#buffers.align) return;
        this.#ensureBindGroup();
        this.#updateUniforms(config);

        const encoder = this.#device.createCommandEncoder();
        const view = this.#context.getCurrentTexture().createView();
        
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: view,
                clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
                loadOp: 'clear', 
                storeOp: 'store',
            }]
        });

        pass.setPipeline(this.#renderPipeline);
        pass.setBindGroup(0, this.#bindGroup);
        pass.draw(3, 1, 0, 0);
        pass.end();

        this.#device.queue.submit([encoder.finish()]);
    }

    async #extractRaster(config, targetRes) {
        if (!this.#buffers.payload || !this.#buffers.align) return null;
        this.#ensureBindGroup();
        this.#updateUniforms(config);

        const format = navigator.gpu.getPreferredCanvasFormat();
        
        const texture = this.#device.createTexture({
            size: { width: targetRes, height: targetRes },
            format: format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
        });

        const encoder = this.#device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: texture.createView(),
                clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
                loadOp: 'clear', storeOp: 'store',
            }]
        });

        pass.setPipeline(this.#renderPipeline);
        pass.setBindGroup(0, this.#bindGroup);
        pass.draw(3, 1, 0, 0);
        pass.end();

        const bytesPerPixel = 4;
        const align = 256;
        const paddedBytesPerRow = Math.ceil((targetRes * bytesPerPixel) / align) * align;
        const bufferSize = paddedBytesPerRow * targetRes;

        const readBuffer = this.#device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });

        encoder.copyTextureToBuffer(
            { texture },
            { buffer: readBuffer, bytesPerRow: paddedBytesPerRow, rowsPerImage: targetRes },
            { width: targetRes, height: targetRes }
        );

        this.#device.queue.submit([encoder.finish()]);
        await this.#device.queue.onSubmittedWorkDone();
        
        await readBuffer.mapAsync(GPUMapMode.READ);
        const src = new Uint8Array(readBuffer.getMappedRange());
        
        const imgData = new ImageData(targetRes, targetRes);
        const isBGRA = format.includes('bgra');

        for (let y = 0; y < targetRes; y++) {
            const srcRow = y * paddedBytesPerRow;
            const destRow = y * targetRes * 4;
            for (let x = 0; x < targetRes; x++) {
                const sp = srcRow + x * 4;
                const dp = destRow + x * 4;
                if (isBGRA) {
                    imgData.data[dp] = src[sp + 2];     
                    imgData.data[dp + 1] = src[sp + 1]; 
                    imgData.data[dp + 2] = src[sp];     
                    imgData.data[dp + 3] = src[sp + 3]; 
                } else {
                    imgData.data[dp] = src[sp];
                    imgData.data[dp + 1] = src[sp + 1];
                    imgData.data[dp + 2] = src[sp + 2];
                    imgData.data[dp + 3] = src[sp + 3];
                }
            }
        }

        readBuffer.unmap();
        texture.destroy();
        readBuffer.destroy();

        return imgData;
    }

    async #renderCompositeCanvas(config, targetRes) {
        const imgData = await this.#extractRaster(config, targetRes);
        if (!imgData) return null;

        const canvas = document.createElement('canvas');
        canvas.width = targetRes;
        canvas.height = targetRes;
        const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        ctx.putImageData(imgData, 0, 0);

        if (config.logoActive && config.logoBlob) {
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = () => reject(new Error("Failed to load logo payload."));
                img.src = config.logoBlob;
            });

            const padding = config.quietZone * 2.0;
            const domainFraction = (config.logoScaleVal * 2.0 * config.dimension) / (config.dimension + padding);
            const logoBoxSize = domainFraction * targetRes;

            ctx.save();
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            const intrinsicWidth = img.naturalWidth || img.width || 300.0;
            const intrinsicHeight = img.naturalHeight || img.height || 300.0;
            const imgRatio = intrinsicWidth / intrinsicHeight;

            let drawW = logoBoxSize;
            let drawH = logoBoxSize;

            if (imgRatio > 1.0) {
                drawH = logoBoxSize / imgRatio;
            } else if (imgRatio < 1.0) {
                drawW = logoBoxSize * imgRatio;
            }

            drawW = Math.round(drawW);
            drawH = Math.round(drawH);
            const dx = Math.round((targetRes - drawW) / 2.0);
            const dy = Math.round((targetRes - drawH) / 2.0);

            ctx.drawImage(img, dx, dy, drawW, drawH);
            ctx.restore();
        }

        return canvas;
    }

    async extractValidationRaster(config, targetRes = 512) {
        const canvas = await this.#renderCompositeCanvas(config, targetRes);
        if (!canvas) return null;
        return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, targetRes, targetRes);
    }

    async exportToCanvas(config, targetRes) {
        return await this.#renderCompositeCanvas(config, targetRes);
    }
}

class UiController {
    #kernel;
    #renderer;
    #dom;
    #state;
    #timers;
    #blobRegistry;

    constructor(wasmKernel, gpuRenderer) {
        this.#kernel = wasmKernel;
        this.#renderer = gpuRenderer;
        
        this.#state = {
            dimension: 0,
            version: 1,
            eccTier: 1,
            alignCount: 0,
            renderScheduled: false,
            visualSize: 0
        };

        this.#timers = { text: null, layout: null };
        this.#blobRegistry = { logo: null, input: null };
        
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

        this.#dom.logoOverlay.classList.remove('transition-all', 'duration-200');
        this.#dom.logoOverlay.style.transition = 'none';
        this.#dom.logoOverlay.style.willChange = 'transform';
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

        this.#dom.mask.addEventListener('change', () => {
            this.#debounceEccValidation();
        });

        this.#dom.logoScale.addEventListener('input', (e) => {
            syncLayoutParams('logoScale', parseFloat(e.target.value));
            this.#updateLogoScaleTransformation();
            this.#requestRender();
        });

        this.#dom.logoScale.addEventListener('change', () => {
            this.#debounceEccValidation();
        });

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

        this.#dom.logoInput.addEventListener('change', (e) => {
            if (!e.target.files.length) return;
            this.#revokeBlob('logo');
            
            this.#blobRegistry.logo = URL.createObjectURL(e.target.files[0]);
            this.#dom.logoOverlay.src = this.#blobRegistry.logo;
            this.#dom.logoOverlay.setAttribute('data-active', 'true');
            
            if (parseFloat(this.#dom.logoScale.value) === 0.0) {
                this.#dom.logoScale.value = 0.15;
                syncLayoutParams('logoScale', 0.15);
            }
            this.#updateLogoScaleTransformation();
            this.#debounceEccValidation();
            this.#requestRender();
        });

        this.#dom.removeLogoBtn.addEventListener('click', () => {
            this.#revokeBlob('logo');
            this.#dom.logoOverlay.src = "";
            this.#dom.logoOverlay.removeAttribute('data-active');
            this.#dom.logoInput.value = "";
            
            this.#updateLogoScaleTransformation();
            this.#requestRender();
            this.#debounceEccValidation();
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

    #debounceEccValidation() {
        clearTimeout(this.#timers.layout);
        this.#timers.layout = setTimeout(() => {
            const requiredEcc = this.#calculateOptimalEcc();
            if (requiredEcc !== this.#state.eccTier && this.#dom.dataEditor.value.trim()) {
                this.#processTextIngestion(this.#dom.dataEditor.value, requiredEcc);
            }
        }, 150);
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
        
        this.#renderer.bindMatrixData(qrState.semanticPayload, qrState.alignmentCenters);
        
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
        
        this.#state.eccTier = 3; 
        const result = this.#kernel.transpileImage(ctx.getImageData(0, 0, w, h), w, h);
        
        if (result) {
            this.#dom.dataEditor.value = result.text;
            this.#updateSemanticContext(result.text);
            this.#validateContrast();
            this.#activateRenderer(result, new TextEncoder().encode(result.text).length);
        } else {
            this.#dom.errorMessage.textContent = "No valid QR field detected, or severe structural anomaly.";
            this.#dom.errorAlert.classList.remove('hidden');
            this.#invalidateValidation();
        }
    }

    #getCurrentConfig() {
        return {
            dimension: this.#state.dimension,
            alignCount: this.#state.alignCount,
            morphPayload: parseFloat(this.#dom.morphPayload.value),
            blendPayload: parseFloat(this.#dom.blendPayload.value),
            maskRadius: parseFloat(this.#dom.mask.value),
            morphAnchor: parseFloat(this.#dom.morphAnchor.value),
            payloadScale: parseFloat(this.#dom.scalePayload.value),
            quietZone: parseFloat(this.#dom.quietZone.value),
            colorPayload: this.#dom.colorPayload.value,
            colorAnchor: this.#dom.colorAnchor.value,
            colorBg: this.#dom.colorBg.value,
            themePayload: parseInt(this.#dom.themePayload.value),
            themeAnchor: parseInt(this.#dom.themeAnchor.value),
            logoBlob: this.#blobRegistry.logo,
            logoActive: this.#dom.logoOverlay.getAttribute('data-active') === 'true',
            logoScaleVal: parseFloat(this.#dom.logoScale.value)
        };
    }

    #requestRender() {
        this.#invalidateValidation();
        if (!this.#state.renderScheduled && this.#state.dimension > 0) {
            this.#state.renderScheduled = true;
            requestAnimationFrame(() => {
                this.#renderer.render(this.#getCurrentConfig());
                this.#state.renderScheduled = false;
            });
        }
    }

    async #executeValidation() {
        const text = this.#dom.dataEditor.value.trim();
        if (!text || this.#state.dimension === 0) return;

        this.#dom.validateBtn.disabled = true;
        this.#dom.validateBtn.innerHTML = `<i data-lucide="loader" class="w-4 h-4 animate-spin"></i> Validating...`;
        lucide.createIcons();

        try {
            const imgData = await this.#renderer.extractValidationRaster(this.#getCurrentConfig(), 512);
            if (!imgData) throw new Error("VRAM Extraction Failed");

            const decodedText = this.#kernel.validateImage(imgData, 512, 512);

            if (decodedText === text) {
                this.#dom.validationStatus.textContent = "Optical Integrity: Verified";
                this.#dom.validationStatus.className = "text-sm font-mono font-bold text-green-600";
            } else {
                this.#dom.validationStatus.textContent = "Optical Integrity: Critical Failure (Distortion/Mask Limit)";
                this.#dom.validationStatus.className = "text-sm font-mono font-bold text-red-600";
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

        try {
            const TARGET_RES = 3840;
            const baseCanvas = await this.#renderer.exportToCanvas(this.#getCurrentConfig(), TARGET_RES);
            if (!baseCanvas) throw new Error("VRAM Mapping Pipeline Failed");

            const link = document.createElement('a');
            link.download = `QR-Export-${Date.now()}.png`;
            link.href = baseCanvas.toDataURL("image/png", 1.0);
            link.click();
            
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