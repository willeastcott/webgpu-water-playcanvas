// WGSL versions of the shared shader helpers (see common.glsl.js for the
// annotated GLSL originals). Notable WGSL differences from the GLSL:
//   - no vec+scalar broadcast: `v + 0.5` must be `v + vec2f(0.5)`.
//   - no swizzle assignment (`info.ba = ...`): assign components individually.
//   - textures are `var t: texture_2d<f32>` + `var tSampler: sampler`; sampled
//     with textureSampleLevel (explicit LOD, valid in non-uniform control flow).
//   - uniforms are read as `uniform.<name>`.

// Constants, always-needed uniforms (light, sphere, water heightmap) and pure
// intersection helpers. Safe for both vertex and fragment stages. Omits the
// tiles/causticTex samplers (see commonHeader) so the caustics shaders never
// bind the caustics render target.
export const commonConstants = /* wgsl */`
  const IOR_AIR: f32 = 1.0;
  const IOR_WATER: f32 = 1.333;
  const abovewaterColor: vec3f = vec3f(0.25, 1.0, 1.25);
  const underwaterColor: vec3f = vec3f(0.4, 0.9, 1.0);
  const poolHeight: f32 = 1.0;
  uniform light: vec3f;
  uniform sphereCenter: vec3f;
  uniform sphereRadius: f32;
  var water: texture_2d<f32>;
  var waterSampler: sampler;

  fn intersectCube(origin: vec3f, ray: vec3f, cubeMin: vec3f, cubeMax: vec3f) -> vec2f {
    let tMin = (cubeMin - origin) / ray;
    let tMax = (cubeMax - origin) / ray;
    let t1 = min(tMin, tMax);
    let t2 = max(tMin, tMax);
    let tNear = max(max(t1.x, t1.y), t1.z);
    let tFar = min(min(t2.x, t2.y), t2.z);
    return vec2f(tNear, tFar);
  }

  fn intersectSphere(origin: vec3f, ray: vec3f, center: vec3f, radius: f32) -> f32 {
    let toSphere = origin - center;
    let a = dot(ray, ray);
    let b = 2.0 * dot(toSphere, ray);
    let c = dot(toSphere, toSphere) - radius * radius;
    let discriminant = b * b - 4.0 * a * c;
    if (discriminant > 0.0) {
      let t = (-b - sqrt(discriminant)) / (2.0 * a);
      if (t > 0.0) { return t; }
    }
    return 1.0e6;
  }
`;

// World-surface shaders additionally sample the pool tiles and caustics texture.
export const commonHeader = commonConstants + /* wgsl */`
  var tiles: texture_2d<f32>;
  var tilesSampler: sampler;
  var causticTex: texture_2d<f32>;
  var causticTexSampler: sampler;
`;

// Texture-sampling shading helpers - fragment stage only.
export const commonShading = /* wgsl */`
  fn getSphereColor(point: vec3f) -> vec3f {
    var color = vec3f(0.5);
    color = color * (1.0 - 0.9 / pow((1.0 + uniform.sphereRadius - abs(point.x)) / uniform.sphereRadius, 3.0));
    color = color * (1.0 - 0.9 / pow((1.0 + uniform.sphereRadius - abs(point.z)) / uniform.sphereRadius, 3.0));
    color = color * (1.0 - 0.9 / pow((point.y + 1.0 + uniform.sphereRadius) / uniform.sphereRadius, 3.0));

    let sphereNormal = (point - uniform.sphereCenter) / uniform.sphereRadius;
    let refractedLight = refract(-uniform.light, vec3f(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);
    var diffuse = max(0.0, dot(-refractedLight, sphereNormal)) * 0.5;
    let info = textureSampleLevel(water, waterSampler, point.xz * 0.5 + vec2f(0.5), 0.0);
    if (point.y < info.r) {
      let caustic = textureSampleLevel(causticTex, causticTexSampler, 0.75 * (point.xz - point.y * refractedLight.xz / refractedLight.y) * 0.5 + vec2f(0.5), 0.0);
      diffuse = diffuse * (caustic.r * 4.0);
    }
    color = color + vec3f(diffuse);
    return color;
  }

  fn getWallColor(point: vec3f) -> vec3f {
    var scale = 0.5;
    var wallColor: vec3f;
    var normal: vec3f;
    if (abs(point.x) > 0.999) {
      wallColor = textureSampleLevel(tiles, tilesSampler, point.yz * 0.5 + vec2f(1.0, 0.5), 0.0).rgb;
      normal = vec3f(-point.x, 0.0, 0.0);
    } else if (abs(point.z) > 0.999) {
      wallColor = textureSampleLevel(tiles, tilesSampler, point.yx * 0.5 + vec2f(1.0, 0.5), 0.0).rgb;
      normal = vec3f(0.0, 0.0, -point.z);
    } else {
      wallColor = textureSampleLevel(tiles, tilesSampler, point.xz * 0.5 + vec2f(0.5), 0.0).rgb;
      normal = vec3f(0.0, 1.0, 0.0);
    }

    scale = scale / length(point);
    scale = scale * (1.0 - 0.9 / pow(length(point - uniform.sphereCenter) / uniform.sphereRadius, 4.0));

    let refractedLight = -refract(-uniform.light, vec3f(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);
    var diffuse = max(0.0, dot(refractedLight, normal));
    let info = textureSampleLevel(water, waterSampler, point.xz * 0.5 + vec2f(0.5), 0.0);
    if (point.y < info.r) {
      let caustic = textureSampleLevel(causticTex, causticTexSampler, 0.75 * (point.xz - point.y * refractedLight.xz / refractedLight.y) * 0.5 + vec2f(0.5), 0.0);
      scale = scale + diffuse * caustic.r * 2.0 * caustic.g;
    } else {
      let t = intersectCube(point, refractedLight, vec3f(-1.0, -poolHeight, -1.0), vec3f(1.0, 2.0, 1.0));
      diffuse = diffuse * (1.0 / (1.0 + exp(-200.0 / (1.0 + 10.0 * (t.y - t.x)) * (point.y + refractedLight.y * t.y - 2.0 / 12.0))));
      scale = scale + diffuse * 0.5;
    }

    return wallColor * scale;
  }
`;
