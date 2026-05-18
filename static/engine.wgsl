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

// Dual-Binding Alias: WebGPU prohibits read_write in the Fragment stage
@group(0) @binding(3) var<storage, read_write> voronoi_rw: array<u32>;
@group(0) @binding(4) var<storage, read> voronoi_r: array<u32>;

// ==========================================
// VORONOI PARTITION KERNEL (COMPUTE)
// ==========================================
@compute @workgroup_size(16, 16)
fn cs_voronoi(@builtin(global_invocation_id) id: vec3<u32>) {
    let dim = config.dimension;
    if (id.x >= dim || id.y >= dim) { return; }
    
    let pos = vec2<f32>(f32(id.x) + 0.5, f32(id.y) + 0.5);
    var bestDist = 999999.0;
    var bestIdx = 999u;

    let finders = array<vec2<f32>, 3>(
        vec2<f32>(3.5), vec2<f32>(f32(dim) - 3.5, 3.5), vec2<f32>(3.5, f32(dim) - 3.5)
    );
    
    for (var i = 0u; i < 3u; i++) {
        let d = length(pos - finders[i]);
        if (d < bestDist) { 
            bestDist = d; 
            bestIdx = i; 
        }
    }

    let count = min(config.alignCount, 50u);
    for (var i = 0u; i < count; i++) {
        let cx = align[i].x + 0.5;
        let cy = align[i].y + 0.5;
        let d = length(pos - vec2<f32>(cx, cy));
        if (d < bestDist) { 
            bestDist = d; 
            bestIdx = i + 3u; 
        }
    }
    
    voronoi_rw[id.y * dim + id.x] = bestIdx;
}

// ==========================================
// VERTEX KERNEL
// ==========================================
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
// ZERO-BANDING PROCEDURAL NOISE
// ==========================================
fn hash21(p: vec2<f32>) -> f32 {
    var p3  = fract(vec3<f32>(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

fn noise(x: vec2<f32>) -> f32 {
    let i = floor(x);
    let f = fract(x);
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
// VOLUMETRIC MATERIAL ENGINE
// ==========================================
fn applyTheme(baseColor: vec3<f32>, qrPos: vec2<f32>, normal: vec3<f32>, theme: u32) -> vec3<f32> {
    let p = qrPos + vec2<f32>(142.1, 89.3);
    let lightDir = normalize(vec3<f32>(1.0, 1.0, 1.5)); 
    let viewDir = vec3<f32>(0.0, 0.0, 1.0);
    
    if (theme == 0u) {
        return baseColor; 
    } 
    else if (theme == 1u) {
        let n = fbm(p * 0.35);
        let intensity = smoothstep(0.3, 0.7, n) * 0.22;
        return mix(baseColor, config.colorBg, intensity);
    } 
    else if (theme == 2u) {
        let wave = sin(p.x * 0.15 + p.y * 0.15) * 0.5 + 0.5;
        let holoColor = vec3<f32>(
            sin(wave * 6.28 + 0.0) * 0.5 + 0.5,
            sin(wave * 6.28 + 2.09) * 0.5 + 0.5,
            sin(wave * 6.28 + 4.18) * 0.5 + 0.5
        );
        return mix(baseColor, holoColor, 0.35);
    } 
    else if (theme == 3u) {
        let n = fbm(p * 0.6);
        let diffuse = max(dot(normal, lightDir), 0.0);
        let halfVector = normalize(lightDir + viewDir);
        let specular = pow(max(dot(normal, halfVector), 0.0), 16.0) * 0.6;
        let litColor = baseColor * (0.6 + 0.4 * diffuse);
        return clamp(litColor + vec3<f32>(specular + (n * 0.1)), vec3<f32>(0.0), vec3<f32>(1.0));
    } 
    else if (theme == 4u) {
        let diffuse = max(dot(normal, lightDir), 0.0);
        let invNormal = normalize(vec3<f32>(-normal.x, -normal.y, normal.z));
        let glassHighlight = pow(max(dot(invNormal, lightDir), 0.0), 32.0) * 0.8;
        let glassBase = mix(baseColor, config.colorBg, 0.3);
        return clamp((glassBase * (0.8 + 0.2 * diffuse)) + vec3<f32>(glassHighlight), vec3<f32>(0.0), vec3<f32>(1.0));
    }
    else if (theme == 5u) {
        let edgeDist = clamp(-normal.z * 3.0, 0.0, 1.0); 
        let coreColor = vec3<f32>(1.0, 1.0, 1.0); 
        return mix(baseColor, coreColor, edgeDist * 0.6); 
    }
    
    return baseColor;
}

// ==========================================
// SIGNED DISTANCE FIELDS
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
// FRAGMENT KERNEL
// ==========================================
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let dim = f32(config.dimension);
    let totalDim = dim + config.quietZone * 2.0;
    let qrPos = in.uv * totalDim - vec2<f32>(config.quietZone);

    var minSDF = 999.0;
    var isAnchorPixel = false;

    let cx = clamp(i32(qrPos.x), 0, i32(dim) - 1);
    let cy = clamp(i32(qrPos.y), 0, i32(dim) - 1);
    
    if (cx >= 0 && cx < i32(dim) && cy >= 0 && cy < i32(dim)) {
        let vIdx = u32(cy) * config.dimension + u32(cx);
        let nearestAnchorIdx = voronoi_r[vIdx]; // Read from Fragment Alias
        
        if (nearestAnchorIdx < 3u) {
            let finders = array<vec2<f32>, 3>(
                vec2<f32>(3.5), vec2<f32>(dim - 3.5, 3.5), vec2<f32>(3.5, dim - 3.5)
            );
            minSDF = getAnchorSDF(qrPos - finders[nearestAnchorIdx], config.morphAnchor);
            isAnchorPixel = true;
        } else if (nearestAnchorIdx < 999u) {
            let aIdx = nearestAnchorIdx - 3u;
            if (aIdx < config.alignCount) {
                let center = align[aIdx] + vec2<f32>(0.5);
                minSDF = getAlignmentSDF(qrPos - center, config.morphAnchor);
                isAnchorPixel = true;
            }
        }
    }

    let cell = floor(qrPos);
    let local = fract(qrPos) - 0.5;

    if (minSDF > -0.5) {
        var payloadSDF = 999.0;

        for (var dy = -2; dy <= 2; dy++) {
            for (var dx = -2; dx <= 2; dx++) {
                let ncx = i32(cell.x) + dx;
                let ncy = i32(cell.y) + dy;
                
                if (ncx >= 0 && ncx < i32(dim) && ncy >= 0 && ncy < i32(dim)) {
                    let idx = u32(ncy) * config.dimension + u32(ncx);
                    if (grid[idx] > 0u) {
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

    // dpdx/dpdy are now safely executed because control flow is perfectly uniform for all quad fragments
    let nx = dpdx(minSDF);
    let ny = dpdy(minSDF);
    let nz = fwidth(minSDF) * 2.0; 
    let normal = normalize(vec3<f32>(nx, ny, max(nz, 0.001)));

    var finalColor = config.colorBg;
    let fw = fwidth(qrPos.x) * 0.7071; 
    
    if (config.themePayload == 5u && minSDF > fw && minSDF < 1.5) {
        let glowStrength = exp(-minSDF * 3.0) * 0.4;
        finalColor = mix(config.colorBg, config.colorPayload, glowStrength);
    }
    
    if (minSDF < fw) {
        let alpha = smoothstep(fw, -fw, minSDF);
        var color = vec3<f32>(0.0);
        
        if (isAnchorPixel) {
            color = applyTheme(config.colorAnchor, qrPos, normal, config.themeAnchor);
        } else {
            color = applyTheme(config.colorPayload, qrPos, normal, config.themePayload);
        }

        finalColor = mix(finalColor, color, alpha);
    }

    // Deferred Mathematical Masking (Replaces the early branch return)
    if (config.maskRadius > 0.0) {
        let center = vec2<f32>(dim * 0.5);
        if (length(qrPos - center) < (config.maskRadius * dim)) {
            finalColor = config.colorBg;
        }
    }

    return vec4<f32>(finalColor, 1.0);
}