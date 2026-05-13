struct Params {
    dimension: u32,
    morph_payload: f32,       
    blend_payload: f32,       
    mask_radius: f32, 
    morph_anchor: f32,
    align_count: u32,
    payload_scale: f32,
    quiet_zone: f32,
    
    color_payload: vec3<f32>,
    theme_payload: u32,      
    
    color_anchor: vec3<f32>,
    theme_anchor: u32,       
    
    color_bg: vec3<f32>,
    pad3: f32,
};

@group(0) @binding(0) var<storage, read> qr_data: array<u32>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read> align_centers: array<vec2<f32>>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) VertexIndex : u32) -> VertexOutput {
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0), vec2<f32>( 3.0, -1.0), vec2<f32>(-1.0,  3.0)
    );
    var output: VertexOutput;
    output.position = vec4<f32>(pos[VertexIndex], 0.0, 1.0);
    output.uv = pos[VertexIndex] * 0.5 + 0.5;
    output.uv.y = 1.0 - output.uv.y;
    return output;
}

fn hash21(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453123);
}

fn noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash21(i + vec2<f32>(0.0, 0.0)), hash21(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash21(i + vec2<f32>(0.0, 1.0)), hash21(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y
    );
}

fn fbm(p: vec2<f32>) -> f32 {
    var v = 0.0;
    var a = 0.5;
    var temp_p = p;
    for (var i = 0u; i < 4u; i++) {
        v += a * noise(temp_p);
        temp_p = temp_p * 2.0 + vec2<f32>(100.0);
        a *= 0.5;
    }
    return v;
}

fn evaluate_material(uv: vec2<f32>, base: vec3<f32>, theme: u32) -> vec3<f32> {
    switch theme {
        case 1u: {
            let n1 = fbm(uv * 8.0);
            let n2 = fbm(uv * 12.0 + vec2<f32>(4.0));
            var col = base;
            if (n1 < 0.35) { col = base * 0.3; } 
            else if (n1 > 0.6) { col = base * 0.7; } 
            if (n2 > 0.65) { col = mix(base, vec3<f32>(0.85, 0.85, 0.75), 0.4); } 
            return col;
        }
        case 2u: {
            let t = length(uv - 0.5) * 3.0 + uv.x * 2.0;
            let shift = vec3<f32>(0.0, 0.33, 0.67);
            let spectrum = 0.5 + 0.5 * cos(6.28318 * (vec3<f32>(1.0) * t + shift));
            return mix(base, spectrum, 0.65);
        }
        case 3u: {
            let t = sin((uv.x - uv.y) * 15.0);
            let highlight = smoothstep(0.8, 1.0, t);
            let shadow = smoothstep(-1.0, -0.8, t);
            return base * (1.0 - shadow * 0.6) + vec3<f32>(1.0, 0.9, 0.7) * highlight * 0.9;
        }
        case 4u: {
            let t = smoothstep(0.0, 1.0, (uv.x + uv.y) * 0.5);
            return mix(base, base * 0.15, t);
        }
        default: {
            return base;
        }
    }
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let a = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    let b = c * 12.92;
    return select(a, b, c <= vec3<f32>(0.0031308));
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
    if (k == 0.0) { return min(a, b); }
    let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

fn lame_sdf(p: vec2<f32>, n: f32, r: f32) -> f32 {
    let ap = abs(p);
    let m = max(max(ap.x, ap.y), 1e-7); 
    let nap = ap / m; 

    let px = pow(nap.x, n);
    let py = pow(nap.y, n);
    let val = px + py;
    let g = m * pow(val, 1.0 / n); 
    
    if (n <= 1.0) {
        return g - r;
    }
    
    let grad_x = pow(nap.x, n - 1.0);
    let grad_y = pow(nap.y, n - 1.0);
    let grad_mag = pow(val, (1.0 / n) - 1.0) * length(vec2<f32>(grad_x, grad_y));
    
    return (g - r) / max(grad_mag, 1e-7);
}

fn grid_to_world(gx: f32, gy: f32, dim_f: f32) -> vec2<f32> {
    let offset = floor(dim_f * 0.5);
    return vec2<f32>(gx - offset, gy - offset);
}

fn sdf_finder(p: vec2<f32>, morph: f32) -> f32 {
    let d_ring = abs(lame_sdf(p, morph, 2.95)) - 0.5;
    let d_dot = lame_sdf(p, morph, 1.45);
    return min(d_ring, d_dot);
}

fn sdf_alignment(p: vec2<f32>, morph: f32) -> f32 {
    let d_ring = abs(lame_sdf(p, morph, 1.95)) - 0.5;
    let d_dot = lame_sdf(p, morph, 0.45);
    return min(d_ring, d_dot);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let dim_f = f32(params.dimension);
    let effective_dim = dim_f + (params.quiet_zone * 2.0);
    let base_p = (in.uv - 0.5) * effective_dim; 

    var dist_anchor = 1000.0;
    let tl = grid_to_world(3.0, 3.0, dim_f);
    let tr = grid_to_world(dim_f - 4.0, 3.0, dim_f);
    let bl = grid_to_world(3.0, dim_f - 4.0, dim_f);

    dist_anchor = min(dist_anchor, sdf_finder(base_p - tl, params.morph_anchor));
    dist_anchor = min(dist_anchor, sdf_finder(base_p - tr, params.morph_anchor));
    dist_anchor = min(dist_anchor, sdf_finder(base_p - bl, params.morph_anchor));

    for (var i = 0u; i < params.align_count; i++) {
        let center = grid_to_world(align_centers[i].x, align_centers[i].y, dim_f);
        dist_anchor = min(dist_anchor, sdf_alignment(base_p - center, params.morph_anchor));
    }

    let cx = round(base_p.x);
    let cy = round(base_p.y);
    
    var dist_fluid_payload = 1000.0; 
    var dist_protected_payload = 1000.0; 
    let search_radius = 3;

    for (var oy = -search_radius; oy <= search_radius; oy++) {
        for (var ox = -search_radius; ox <= search_radius; ox++) {
            let cell_x = i32(cx) + ox;
            let cell_y = i32(cy) + oy;
            let arr_x = cell_x + i32(dim_f * 0.5);
            let arr_y = cell_y + i32(dim_f * 0.5);

            if (arr_x >= 0 && arr_x < i32(params.dimension) && arr_y >= 0 && arr_y < i32(params.dimension)) {
                let idx = u32(arr_y) * params.dimension + u32(arr_x);
                let state = qr_data[idx];
                
                if (state > 0u) {
                    let center = vec2<f32>(f32(cell_x), f32(cell_y));
                    let local_d = lame_sdf(base_p - center, params.morph_payload, params.payload_scale * 0.5);
                    
                    if (state == 2u) {
                        dist_protected_payload = smin(dist_protected_payload, local_d, params.blend_payload);
                    } else {
                        dist_fluid_payload = smin(dist_fluid_payload, local_d, params.blend_payload);
                    }
                }
            }
        }
    }

    if (params.mask_radius > 0.0) {
        let mask_dist = length(base_p) - (params.mask_radius * dim_f);
        dist_fluid_payload = max(dist_fluid_payload, -mask_dist); 
    }

    let dist_total_payload = min(dist_fluid_payload, dist_protected_payload);

    let aa_width = max(max(abs(dpdx(base_p.x)), abs(dpdy(base_p.y))), 0.005);
    let alpha_payload = 1.0 - smoothstep(-aa_width, aa_width, dist_total_payload);
    let alpha_anchor = 1.0 - smoothstep(-aa_width, aa_width, dist_anchor);
    
    // ARCHITECTURAL FIX: Evaluate uniform directly. No pipeline variations, no AST parsing bugs.
    let mat_payload = evaluate_material(in.uv, params.color_payload, params.theme_payload);
    let mat_anchor = evaluate_material(in.uv, params.color_anchor, params.theme_anchor);

    var final_color = params.color_bg;
    final_color = mix(final_color, mat_payload, alpha_payload);
    final_color = mix(final_color, mat_anchor, alpha_anchor); 
    
    return vec4<f32>(linear_to_srgb(final_color), 1.0);
}