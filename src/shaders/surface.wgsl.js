// WGSL versions of the visible-scene + caustics shaders (see surface.glsl.js
// for the annotated GLSL originals). The world-space varying is named
// `vWorldPos` rather than `position` because WGSL reserves `output.position`
// for the clip-space builtin.
import { commonConstants, commonHeader, commonShading } from './common.wgsl.js';

const commonFrag = commonHeader + commonShading;

// ---------------------------------------------------------------------------
// Water surface
// ---------------------------------------------------------------------------

export const waterVertexWGSL = commonConstants + /* wgsl */`
  attribute aPosition: vec3f;
  uniform matrix_viewProjection: mat4x4f;
  varying vWorldPos: vec3f;
  @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let info = textureSampleLevel(water, waterSampler, input.aPosition.xy * 0.5 + vec2f(0.5), 0.0);
    var pos = input.aPosition.xzy;
    pos.y = pos.y + info.r;
    output.vWorldPos = pos;
    output.position = uniform.matrix_viewProjection * vec4f(pos, 1.0);
    return output;
  }
`;

// Shared ray-marched shading used by both above- and below-water passes.
const surfaceRayColor = /* wgsl */`
  uniform eye: vec3f;
  var sky: texture_cube<f32>;
  var skySampler: sampler;
  varying vWorldPos: vec3f;

  struct RayInfo { normal: vec3f, incomingRay: vec3f };

  fn getSurfaceRayColor(origin: vec3f, ray: vec3f, waterColor: vec3f) -> vec3f {
    var color: vec3f;
    let q = intersectSphere(origin, ray, uniform.sphereCenter, uniform.sphereRadius);
    if (q < 1.0e6) {
      color = getSphereColor(origin + ray * q);
    } else if (ray.y < 0.0) {
      let t = intersectCube(origin, ray, vec3f(-1.0, -poolHeight, -1.0), vec3f(1.0, 2.0, 1.0));
      color = getWallColor(origin + ray * t.y);
    } else {
      let t = intersectCube(origin, ray, vec3f(-1.0, -poolHeight, -1.0), vec3f(1.0, 2.0, 1.0));
      let hit = origin + ray * t.y;
      if (hit.y < 2.0 / 12.0) {
        color = getWallColor(hit);
      } else {
        color = textureSampleLevel(sky, skySampler, ray, 0.0).rgb;
        color = color + vec3f(pow(max(0.0, dot(uniform.light, ray)), 5000.0)) * vec3f(10.0, 8.0, 6.0);
      }
    }
    if (ray.y < 0.0) { color = color * waterColor; }
    return color;
  }

  fn computeNormalAndRay(position: vec3f) -> RayInfo {
    var coord = position.xz * 0.5 + vec2f(0.5);
    var info = textureSampleLevel(water, waterSampler, coord, 0.0);

    /* make water look more "peaked" */
    for (var i = 0; i < 5; i++) {
      coord = coord + info.ba * 0.005;
      info = textureSampleLevel(water, waterSampler, coord, 0.0);
    }

    var result: RayInfo;
    result.normal = vec3f(info.b, sqrt(1.0 - dot(info.ba, info.ba)), info.a);
    result.incomingRay = normalize(position - uniform.eye);
    return result;
  }
`;

export const waterAboveFragmentWGSL = commonFrag + surfaceRayColor + /* wgsl */`
  @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    let ri = computeNormalAndRay(input.vWorldPos);
    let normal = ri.normal;
    let incomingRay = ri.incomingRay;

    let reflectedRay = reflect(incomingRay, normal);
    let refractedRay = refract(incomingRay, normal, IOR_AIR / IOR_WATER);
    let fresnel = mix(0.25, 1.0, pow(1.0 - dot(normal, -incomingRay), 3.0));

    let reflectedColor = getSurfaceRayColor(input.vWorldPos, reflectedRay, abovewaterColor);
    let refractedColor = getSurfaceRayColor(input.vWorldPos, refractedRay, abovewaterColor);

    var output: FragmentOutput;
    output.color = vec4f(mix(refractedColor, reflectedColor, fresnel), 1.0);
    return output;
  }
`;

export const waterBelowFragmentWGSL = commonFrag + surfaceRayColor + /* wgsl */`
  @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    let ri = computeNormalAndRay(input.vWorldPos);
    let normal = -ri.normal;
    let incomingRay = ri.incomingRay;

    let reflectedRay = reflect(incomingRay, normal);
    let refractedRay = refract(incomingRay, normal, IOR_WATER / IOR_AIR);
    let fresnel = mix(0.5, 1.0, pow(1.0 - dot(normal, -incomingRay), 3.0));

    let reflectedColor = getSurfaceRayColor(input.vWorldPos, reflectedRay, underwaterColor);
    let refractedColor = getSurfaceRayColor(input.vWorldPos, refractedRay, vec3f(1.0)) * vec3f(0.8, 1.0, 1.1);

    var output: FragmentOutput;
    output.color = vec4f(mix(reflectedColor, refractedColor, (1.0 - fresnel) * length(refractedRay)), 1.0);
    return output;
  }
`;

// ---------------------------------------------------------------------------
// Sphere
// ---------------------------------------------------------------------------

export const sphereVertexWGSL = commonConstants + /* wgsl */`
  attribute aPosition: vec3f;
  uniform matrix_viewProjection: mat4x4f;
  varying vWorldPos: vec3f;
  @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let pos = uniform.sphereCenter + input.aPosition * uniform.sphereRadius;
    output.vWorldPos = pos;
    output.position = uniform.matrix_viewProjection * vec4f(pos, 1.0);
    return output;
  }
`;

export const sphereFragmentWGSL = commonFrag + /* wgsl */`
  varying vWorldPos: vec3f;
  @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var color = vec4f(getSphereColor(input.vWorldPos), 1.0);
    let info = textureSampleLevel(water, waterSampler, input.vWorldPos.xz * 0.5 + vec2f(0.5), 0.0);
    if (input.vWorldPos.y < info.r) {
      color = vec4f(color.rgb * (underwaterColor * 1.2), color.a);
    }
    var output: FragmentOutput;
    output.color = color;
    return output;
  }
`;

// ---------------------------------------------------------------------------
// Pool (cube)
// ---------------------------------------------------------------------------

export const cubeVertexWGSL = commonConstants + /* wgsl */`
  attribute aPosition: vec3f;
  uniform matrix_viewProjection: mat4x4f;
  varying vWorldPos: vec3f;
  @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    var pos = input.aPosition;
    pos.y = ((1.0 - pos.y) * (7.0 / 12.0) - 1.0) * poolHeight;
    output.vWorldPos = pos;
    output.position = uniform.matrix_viewProjection * vec4f(pos, 1.0);
    return output;
  }
`;

export const cubeFragmentWGSL = commonFrag + /* wgsl */`
  varying vWorldPos: vec3f;
  @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var color = vec4f(getWallColor(input.vWorldPos), 1.0);
    let info = textureSampleLevel(water, waterSampler, input.vWorldPos.xz * 0.5 + vec2f(0.5), 0.0);
    if (input.vWorldPos.y < info.r) {
      color = vec4f(color.rgb * (underwaterColor * 1.2), color.a);
    }
    var output: FragmentOutput;
    output.color = color;
    return output;
  }
`;

// ---------------------------------------------------------------------------
// Caustics
// ---------------------------------------------------------------------------

export const causticsVertexWGSL = commonConstants + /* wgsl */`
  attribute aPosition: vec3f;
  varying oldPos: vec3f;
  varying newPos: vec3f;
  varying ray: vec3f;

  fn project(origin0: vec3f, ray: vec3f, refractedLight: vec3f) -> vec3f {
    let tcube = intersectCube(origin0, ray, vec3f(-1.0, -poolHeight, -1.0), vec3f(1.0, 2.0, 1.0));
    let origin = origin0 + ray * tcube.y;
    let tplane = (-origin.y - 1.0) / refractedLight.y;
    return origin + refractedLight * tplane;
  }

  @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let info = textureSampleLevel(water, waterSampler, input.aPosition.xy * 0.5 + vec2f(0.5), 0.0);
    let ba = info.ba * 0.5;
    let normal = vec3f(ba.x, sqrt(1.0 - dot(ba, ba)), ba.y);

    let refractedLight = refract(-uniform.light, vec3f(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);
    let rayv = refract(-uniform.light, normal, IOR_AIR / IOR_WATER);
    output.ray = rayv;
    output.oldPos = project(input.aPosition.xzy, refractedLight, refractedLight);
    output.newPos = project(input.aPosition.xzy + vec3f(0.0, info.r, 0.0), rayv, refractedLight);

    output.position = vec4f(0.75 * (output.newPos.xz + refractedLight.xz / refractedLight.y), 0.0, 1.0);
    return output;
  }
`;

export const causticsFragmentWGSL = commonConstants + /* wgsl */`
  varying oldPos: vec3f;
  varying newPos: vec3f;
  varying ray: vec3f;

  @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    /* if the triangle gets smaller, it gets brighter, and vice versa */
    let oldArea = length(dpdx(input.oldPos)) * length(dpdy(input.oldPos));
    let newArea = length(dpdx(input.newPos)) * length(dpdy(input.newPos));
    var color = vec4f(oldArea / newArea * 0.2, 1.0, 0.0, 0.0);

    let refractedLight = refract(-uniform.light, vec3f(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);

    /* blob shadow, only where the player blocks the light */
    let dir = (uniform.sphereCenter - input.newPos) / uniform.sphereRadius;
    let area = cross(dir, refractedLight);
    var shadow = dot(area, area);
    let dist = dot(dir, -refractedLight);
    shadow = 1.0 + (shadow - 1.0) / (0.05 + dist * 0.025);
    shadow = clamp(1.0 / (1.0 + exp(-shadow)), 0.0, 1.0);
    shadow = mix(1.0, shadow, clamp(dist * 2.0, 0.0, 1.0));
    color.g = shadow;

    /* shadow for the rim of the pool */
    let t = intersectCube(input.newPos, -refractedLight, vec3f(-1.0, -poolHeight, -1.0), vec3f(1.0, 2.0, 1.0));
    color.r = color.r * (1.0 / (1.0 + exp(-200.0 / (1.0 + 10.0 * (t.y - t.x)) * (input.newPos.y - refractedLight.y * t.y - 2.0 / 12.0))));

    var output: FragmentOutput;
    output.color = color;
    return output;
  }
`;
