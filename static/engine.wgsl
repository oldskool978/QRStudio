struct Config {
    dimension: u32,
    morphPayload: f32,
    blendPayload: f32,
    maskRadius: f32,
    morphAnchor: f32,
    alignCount: u32,
    payloadScale: f32,
    quietZone: f32,
    colorPayload: vec3<f32>,
    themePayload: u32,
    colorAnchor: vec3<f32>,
    themeAnchor: u32,
    colorBg: vec3<f32>,
    pad: u32,
};

@group(0) @binding(0) var<storage, read> grid: array<u32>;
@group(0) @binding(1) var<uniform> config: Config;
@group(0) @binding(2) var<storage, read> align: array<vec2<f32>>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var output: VertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    output.uv = pos[vertexIndex] * 0.5 + 0.5;
    output.uv.y = 1.0 - output.uv.y; 
    return output;
}

// ==========================================
// ZERO-BANDING PROCEDURAL ENTROPY ENGINE
// ==========================================
// Dave Hoskins' Hash - AAA Standard for banding-free GPU noise
fn hash21(p: vec2<f32>) -> f32 {
    var p3  = fract(vec3<f32>(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn noise(x: vec2<f32>) -> f32 {
    let i = floor(x);
    let f = fract(x);
    // Quintic Hermite interpolation
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(
        mix(hash21(i + vec2<f32>(0.0, 0.0)), hash21(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y
    );
}

fn fbm(x: vec2<f32>) -> f32 {
    var v = 0.0;
    var a = 0.5;
    var shift = vec2<f32>(100.0);
    // Rotational matrix to break grid alignment artifacts
    let rot = mat2x2<f32>(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
    var p = x;
    for (var i = 0u; i < 4u; i++) {
        v += a * noise(p);
        p = rot * p * 2.0 + shift;
        a *= 0.5;
    }
    return v;
}

// ==========================================
// MATERIAL & THEME SHADERS
// ==========================================
// Evaluation shifted to grid-space (qrPos) to adapt to module density
fn applyTheme(baseColor: vec3<f32>, qrPos: vec2<f32>, theme: u32) -> vec3<f32> {
    // Offset to bypass origin singularities
    let p = qrPos + vec2<f32>(142.1, 89.3);

    if (theme == 0u) {
        return baseColor;
        
    } else if (theme == 1u) {
        // Camouflage: Grid-Relative High-Frequency Noise
        // Frequency bounded so features max out at ~3 modules wide. 
        let n = fbm(p * 0.35);
        let intensity = smoothstep(0.3, 0.7, n) * 0.22; // 22% max variance
        return mix(baseColor, config.colorBg, intensity);
        
    } else if (theme == 2u) {
        // Holographic Iridescence
        let wave = sin(p.x * 0.15 + p.y * 0.15) * 0.5 + 0.5;
        let holoColor = vec3<f32>(
            sin(wave * 6.28 + 0.0) * 0.5 + 0.5,
            sin(wave * 6.28 + 2.09) * 0.5 + 0.5,
            sin(wave * 6.28 + 4.18) * 0.5 + 0.5
        );
        return mix(baseColor, holoColor, 0.35);
        
    } else if (theme == 3u) {
        // Liquid Metal Specular
        let n = fbm(p * 0.6); // Sharp frequency
        let specular = pow(n, 4.0) * 0.45; // Tight highlights
        return clamp(baseColor + vec3<f32>(specular), vec3<f32>(0.0), vec3<f32>(1.0));
        
    } else if (theme == 4u) {
        // Linear Fade Gradient (Diagonal Matrix Space)
        let dim = f32(config.dimension);
        let grad = clamp((qrPos.x + qrPos.y) / (dim * 2.0), 0.0, 1.0);
        return mix(baseColor, config.colorBg, grad * 0.30); // Max 30% fade
    }
    
    return baseColor;
}

// ==========================================
// SIGNED DISTANCE FIELDS (SDF)
// ==========================================
fn sdRoundedBox(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - b + vec2<f32>(r);
    return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn sdCircle(p: vec2<f32>, r: f32) -> f32 {
    return length(p) - r;
}

fn getAnchorSDF(p: vec2<f32>, morph: f32) -> f32 {
    let r = morph * 0.3;
    let outer = sdRoundedBox(p, vec2<f32>(3.5), r);
    let voidSpace = sdRoundedBox(p, vec2<f32>(2.5), r * 0.7);
    let inner = sdRoundedBox(p, vec2<f32>(1.5), r * 0.4);
    
    let ring = max(outer, -voidSpace);
    return min(ring, inner);
}

fn getAlignmentSDF(p: vec2<f32>, morph: f32) -> f32 {
    let r = morph * 0.3;
    let outer = sdRoundedBox(p, vec2<f32>(2.5), r);
    let voidSpace = sdRoundedBox(p, vec2<f32>(1.5), r * 0.5);
    let inner = sdRoundedBox(p, vec2<f32>(0.5), r * 0.2);
    
    let ring = max(outer, -voidSpace);
    return min(ring, inner);
}

// ==========================================
// RENDER PIPELINE
// ==========================================
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let dim = f32(config.dimension);
    let totalDim = dim + config.quietZone * 2.0;
    
    // Grid-Space Coordinate (qrPos maps exactly to module indices)
    let qrPos = in.uv * totalDim - vec2<f32>(config.quietZone);

    // 1. HARDWARE MASKING (Void Layer)
    let center = vec2<f32>(dim * 0.5);
    if (config.maskRadius > 0.0) {
        let distToCenter = length(qrPos - center);
        if (distToCenter < (config.maskRadius * dim)) {
            return vec4<f32>(config.colorBg, 1.0);
        }
    }

    var finalColor = config.colorBg;
    var minSDF = 999.0;
    var isAnchorPixel = false;

    // 2. EXPLICIT ANCHOR RECONSTRUCTION (Finders)
    let finders = array<vec2<f32>, 3>(
        vec2<f32>(3.5),
        vec2<f32>(dim - 3.5, 3.5),
        vec2<f32>(3.5, dim - 3.5)
    );

    for (var i = 0u; i < 3u; i++) {
        let d = getAnchorSDF(qrPos - finders[i], config.morphAnchor);
        if (d < minSDF) { minSDF = d; isAnchorPixel = true; }
    }

    // 3. EXPLICIT ALIGNMENT RECONSTRUCTION
    let count = min(config.alignCount, 50u); 
    for (var i = 0u; i < count; i++) {
        let cx = align[i].x + 0.5;
        let cy = align[i].y + 0.5;
        let d = getAlignmentSDF(qrPos - vec2<f32>(cx, cy), config.morphAnchor);
        if (d < minSDF) { minSDF = d; isAnchorPixel = true; }
    }

    // 4. PAYLOAD MORPHOLOGY (Fluid Blend)
    let cell = floor(qrPos);
    let local = fract(qrPos) - 0.5;

    if (minSDF > -0.5) {
        var payloadSDF = 999.0;

        for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
                let cx = i32(cell.x) + dx;
                let cy = i32(cell.y) + dy;
                
                if (cx >= 0 && cx < i32(dim) && cy >= 0 && cy < i32(dim)) {
                    let idx = u32(cy) * config.dimension + u32(cx);
                    let val = grid[idx];
                    
                    if (val > 0u) {
                        let p = local - vec2<f32>(f32(dx), f32(dy));
                        
                        var d = 0.0;
                        let r = config.morphPayload * 0.5 * config.payloadScale;
                        let boxSize = vec2<f32>(0.5 * config.payloadScale);
                        
                        if (config.morphPayload > 0.95) {
                            d = sdCircle(p, boxSize.x);
                        } else {
                            d = sdRoundedBox(p, boxSize, r);
                        }

                        if (payloadSDF == 999.0) {
                            payloadSDF = d;
                        } else {
                            let k = clamp(0.5 + 0.5 * (payloadSDF - d) / config.blendPayload, 0.0, 1.0);
                            payloadSDF = mix(payloadSDF, d, k) - config.blendPayload * k * (1.0 - k);
                        }
                    }
                }
            }
        }

        if (payloadSDF < minSDF) {
            minSDF = payloadSDF;
            isAnchorPixel = false;
        }
    }

    // 5. ANTI-ALIASING & GRID-SPACE THEME INJECTION
    let fw = fwidth(qrPos.x) * 0.7071; 
    
    if (minSDF < fw) {
        let alpha = smoothstep(fw, -fw, minSDF);
        var color = vec3<f32>(0.0);
        
        // Pass qrPos to applyTheme for resolution-independent texturing
        if (isAnchorPixel) {
            color = applyTheme(config.colorAnchor, qrPos, config.themeAnchor);
        } else {
            color = applyTheme(config.colorPayload, qrPos, config.themePayload);
        }

        finalColor = mix(config.colorBg, color, alpha);
    }

    return vec4<f32>(finalColor, 1.0);
}