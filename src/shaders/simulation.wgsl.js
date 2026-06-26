// WGSL versions of the GPGPU simulation passes (see simulation.glsl.js for the
// annotated GLSL originals). Provided alongside the GLSL so the WebGPU backend
// uses these directly instead of transpiling. Uniforms are supplied via
// `device.scope` and read as `uniform.<name>`; the input texture sampler is the
// texture name + 'Sampler'. All fetches use textureSampleLevel (explicit LOD 0;
// the heightmap has no mipmaps) so they are valid in any control flow.

// Shared vertex shader: full-screen clip-space quad, passes [0,1] coord.
export const simVertexWGSL = /* wgsl */`
  attribute aPosition: vec2f;
  varying coord: vec2f;
  @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.coord = input.aPosition * 0.5 + vec2f(0.5);
    output.position = vec4f(input.aPosition, 0.0, 1.0);
    return output;
  }
`;

// Initialise the heightmap to zero. The unused 'coord' varying is declared so
// the engine generates a FragmentInput struct (it has no other varying inputs).
export const clearFragmentWGSL = /* wgsl */`
  varying coord: vec2f;
  @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    output.color = vec4f(0.0);
    return output;
  }
`;

// Add an interactive drop (raised-cosine bump).
export const dropFragmentWGSL = /* wgsl */`
  var uSource: texture_2d<f32>;
  var uSourceSampler: sampler;
  uniform center: vec2f;
  uniform radius: f32;
  uniform strength: f32;
  varying coord: vec2f;
  const PI: f32 = 3.141592653589793;
  @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var info = textureSampleLevel(uSource, uSourceSampler, input.coord, 0.0);
    var drop = max(0.0, 1.0 - length(uniform.center * 0.5 + vec2f(0.5) - input.coord) / uniform.radius);
    drop = 0.5 - cos(drop * PI) * 0.5;
    info.r = info.r + drop * uniform.strength;
    var output: FragmentOutput;
    output.color = info;
    return output;
  }
`;

// Advance the wave equation one step.
export const updateFragmentWGSL = /* wgsl */`
  var uSource: texture_2d<f32>;
  var uSourceSampler: sampler;
  uniform delta: vec2f;
  varying coord: vec2f;
  @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var info = textureSampleLevel(uSource, uSourceSampler, input.coord, 0.0);
    let dx = vec2f(uniform.delta.x, 0.0);
    let dy = vec2f(0.0, uniform.delta.y);
    let average = (
      textureSampleLevel(uSource, uSourceSampler, input.coord - dx, 0.0).r +
      textureSampleLevel(uSource, uSourceSampler, input.coord - dy, 0.0).r +
      textureSampleLevel(uSource, uSourceSampler, input.coord + dx, 0.0).r +
      textureSampleLevel(uSource, uSourceSampler, input.coord + dy, 0.0).r
    ) * 0.25;
    info.g = info.g + (average - info.r) * 2.0;
    info.g = info.g * 0.995;
    info.r = info.r + info.g;
    var output: FragmentOutput;
    output.color = info;
    return output;
  }
`;

// Recompute surface normals (stored in BA) from height derivatives.
export const normalFragmentWGSL = /* wgsl */`
  var uSource: texture_2d<f32>;
  var uSourceSampler: sampler;
  uniform delta: vec2f;
  varying coord: vec2f;
  @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var info = textureSampleLevel(uSource, uSourceSampler, input.coord, 0.0);
    let dx = vec3f(uniform.delta.x, textureSampleLevel(uSource, uSourceSampler, vec2f(input.coord.x + uniform.delta.x, input.coord.y), 0.0).r - info.r, 0.0);
    let dy = vec3f(0.0, textureSampleLevel(uSource, uSourceSampler, vec2f(input.coord.x, input.coord.y + uniform.delta.y), 0.0).r - info.r, uniform.delta.y);
    let n = normalize(cross(dy, dx));
    info.b = n.x;
    info.a = n.z;
    var output: FragmentOutput;
    output.color = info;
    return output;
  }
`;

// Displace water as the sphere moves (add old volume, subtract new).
export const sphereFragmentWGSL = /* wgsl */`
  var uSource: texture_2d<f32>;
  var uSourceSampler: sampler;
  uniform oldCenter: vec3f;
  uniform newCenter: vec3f;
  uniform radius: f32;
  varying coord: vec2f;

  fn volumeInSphere(center: vec3f, coord: vec2f, radius: f32) -> f32 {
    let toCenter = vec3f(coord.x * 2.0 - 1.0, 0.0, coord.y * 2.0 - 1.0) - center;
    let t = length(toCenter) / radius;
    let dy = exp(-pow(t * 1.5, 6.0));
    let ymin = min(0.0, center.y - dy);
    let ymax = min(max(0.0, center.y + dy), ymin + 2.0 * dy);
    return (ymax - ymin) * 0.1;
  }

  @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var info = textureSampleLevel(uSource, uSourceSampler, input.coord, 0.0);
    info.r = info.r + volumeInSphere(uniform.oldCenter, input.coord, uniform.radius);
    info.r = info.r - volumeInSphere(uniform.newCenter, input.coord, uniform.radius);
    var output: FragmentOutput;
    output.color = info;
    return output;
  }
`;
