// Visible-scene + caustics shaders, ported from Evan Wallace's renderer.js.
// Each is prefixed with the shared `common` helpers (exactly as the original
// prepends `helperFunctions`). Translation notes vs the original:
//   - `gl_Vertex`                 -> `aPosition` (SEMANTIC_POSITION attribute)
//   - `gl_ModelViewProjectionMatrix` -> `matrix_viewProjection` (geometry is
//     authored in world space, so the model matrix is identity)
//   - texture fetches reachable from the ray tracer's non-uniform control flow
//     use texture2DLod / textureCubeLod (explicit LOD), which WebGPU/WGSL
//     requires (implicit-LOD textureSample is illegal in non-uniform control
//     flow). Those helpers live in `commonShading`, prepended to fragment
//     shaders only (the macros are undefined in the vertex stage).
//   - fragment shaders accumulate into a local `vec4 color` and write
//     `gl_FragColor` once at the end (avoids reading back the output var).
import { commonConstants, commonHeader, commonShading } from './common.glsl.js';

// World-surface fragment shaders get the full header (tile/caustics samplers)
// plus the texture-sampling shading helpers. Vertex shaders and the caustics
// shaders use commonConstants only (no tile/caustics samplers).
const commonFrag = commonHeader + commonShading;

// ---------------------------------------------------------------------------
// Water surface
// ---------------------------------------------------------------------------

// Displaces the flat grid by the simulated height and forwards world position.
export const waterVertexGLSL = commonConstants + /* glsl */`
  attribute vec3 aPosition;
  uniform mat4 matrix_viewProjection;
  varying vec3 position;
  void main() {
    vec4 info = texture2D(water, aPosition.xy * 0.5 + 0.5);
    position = aPosition.xzy;
    position.y += info.r;
    gl_Position = matrix_viewProjection * vec4(position, 1.0);
  }
`;

// Shared ray-marched shading used by both the above- and below-water passes.
const surfaceRayColor = /* glsl */`
  uniform vec3 eye;
  uniform samplerCube sky;
  varying vec3 position;

  vec3 getSurfaceRayColor(vec3 origin, vec3 ray, vec3 waterColor) {
    vec3 color;
    float q = intersectSphere(origin, ray, sphereCenter, sphereRadius);
    if (q < 1.0e6) {
      color = getSphereColor(origin + ray * q);
    } else if (ray.y < 0.0) {
      vec2 t = intersectCube(origin, ray, vec3(-1.0, -poolHeight, -1.0), vec3(1.0, 2.0, 1.0));
      color = getWallColor(origin + ray * t.y);
    } else {
      vec2 t = intersectCube(origin, ray, vec3(-1.0, -poolHeight, -1.0), vec3(1.0, 2.0, 1.0));
      vec3 hit = origin + ray * t.y;
      if (hit.y < 2.0 / 12.0) {
        color = getWallColor(hit);
      } else {
        color = textureCubeLod(sky, ray, 0.0).rgb;
        color += vec3(pow(max(0.0, dot(light, ray)), 5000.0)) * vec3(10.0, 8.0, 6.0);
      }
    }
    if (ray.y < 0.0) color *= waterColor;
    return color;
  }

  vec3 computeNormalAndRay(out vec3 normal, out vec3 incomingRay) {
    vec2 coord = position.xz * 0.5 + 0.5;
    vec4 info = texture2D(water, coord);

    /* make water look more "peaked" */
    for (int i = 0; i < 5; i++) {
      coord += info.ba * 0.005;
      info = texture2D(water, coord);
    }

    normal = vec3(info.b, sqrt(1.0 - dot(info.ba, info.ba)), info.a);
    incomingRay = normalize(position - eye);
    return normal;
  }
`;

// View from above the water.
export const waterAboveFragmentGLSL = commonFrag + surfaceRayColor + /* glsl */`
  void main() {
    vec3 normal, incomingRay;
    computeNormalAndRay(normal, incomingRay);

    vec3 reflectedRay = reflect(incomingRay, normal);
    vec3 refractedRay = refract(incomingRay, normal, IOR_AIR / IOR_WATER);
    float fresnel = mix(0.25, 1.0, pow(1.0 - dot(normal, -incomingRay), 3.0));

    vec3 reflectedColor = getSurfaceRayColor(position, reflectedRay, abovewaterColor);
    vec3 refractedColor = getSurfaceRayColor(position, refractedRay, abovewaterColor);

    gl_FragColor = vec4(mix(refractedColor, reflectedColor, fresnel), 1.0);
  }
`;

// View from below the water (inverted normal and IOR).
export const waterBelowFragmentGLSL = commonFrag + surfaceRayColor + /* glsl */`
  void main() {
    vec3 normal, incomingRay;
    computeNormalAndRay(normal, incomingRay);
    normal = -normal;

    vec3 reflectedRay = reflect(incomingRay, normal);
    vec3 refractedRay = refract(incomingRay, normal, IOR_WATER / IOR_AIR);
    float fresnel = mix(0.5, 1.0, pow(1.0 - dot(normal, -incomingRay), 3.0));

    vec3 reflectedColor = getSurfaceRayColor(position, reflectedRay, underwaterColor);
    vec3 refractedColor = getSurfaceRayColor(position, refractedRay, vec3(1.0)) * vec3(0.8, 1.0, 1.1);

    gl_FragColor = vec4(mix(reflectedColor, refractedColor, (1.0 - fresnel) * length(refractedRay)), 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Sphere
// ---------------------------------------------------------------------------

export const sphereVertexGLSL = commonConstants + /* glsl */`
  attribute vec3 aPosition;
  uniform mat4 matrix_viewProjection;
  varying vec3 position;
  void main() {
    position = sphereCenter + aPosition.xyz * sphereRadius;
    gl_Position = matrix_viewProjection * vec4(position, 1.0);
  }
`;

export const sphereFragmentGLSL = commonFrag + /* glsl */`
  varying vec3 position;
  void main() {
    vec4 color = vec4(getSphereColor(position), 1.0);
    vec4 info = texture2D(water, position.xz * 0.5 + 0.5);
    if (position.y < info.r) {
      color.rgb *= underwaterColor * 1.2;
    }
    gl_FragColor = color;
  }
`;

// ---------------------------------------------------------------------------
// Pool (cube). Authored as a unit cube in [-1,1]; the Y coordinate is remapped
// in the vertex shader so the floor sits at y=-poolHeight and the rim at 2/12.
// ---------------------------------------------------------------------------

export const cubeVertexGLSL = commonConstants + /* glsl */`
  attribute vec3 aPosition;
  uniform mat4 matrix_viewProjection;
  varying vec3 position;
  void main() {
    position = aPosition.xyz;
    position.y = ((1.0 - position.y) * (7.0 / 12.0) - 1.0) * poolHeight;
    gl_Position = matrix_viewProjection * vec4(position, 1.0);
  }
`;

export const cubeFragmentGLSL = commonFrag + /* glsl */`
  varying vec3 position;
  void main() {
    vec4 color = vec4(getWallColor(position), 1.0);
    vec4 info = texture2D(water, position.xz * 0.5 + 0.5);
    if (position.y < info.r) {
      color.rgb *= underwaterColor * 1.2;
    }
    gl_FragColor = color;
  }
`;

// ---------------------------------------------------------------------------
// Caustics. Projects each water-surface vertex along its refracted light ray
// onto the pool floor; the fragment stage measures how the projected area
// changed (differential-area method) to get caustic brightness.
// ---------------------------------------------------------------------------

export const causticsVertexGLSL = commonConstants + /* glsl */`
  attribute vec3 aPosition;
  varying vec3 oldPos;
  varying vec3 newPos;
  varying vec3 ray;

  /* project the ray onto the plane */
  vec3 project(vec3 origin, vec3 ray, vec3 refractedLight) {
    vec2 tcube = intersectCube(origin, ray, vec3(-1.0, -poolHeight, -1.0), vec3(1.0, 2.0, 1.0));
    origin += ray * tcube.y;
    float tplane = (-origin.y - 1.0) / refractedLight.y;
    return origin + refractedLight * tplane;
  }

  void main() {
    vec4 info = texture2D(water, aPosition.xy * 0.5 + 0.5);
    info.ba *= 0.5;
    vec3 normal = vec3(info.b, sqrt(1.0 - dot(info.ba, info.ba)), info.a);

    /* project the vertices along the refracted vertex ray */
    vec3 refractedLight = refract(-light, vec3(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);
    ray = refract(-light, normal, IOR_AIR / IOR_WATER);
    oldPos = project(aPosition.xzy, refractedLight, refractedLight);
    newPos = project(aPosition.xzy + vec3(0.0, info.r, 0.0), ray, refractedLight);

    gl_Position = vec4(0.75 * (newPos.xz + refractedLight.xz / refractedLight.y), 0.0, 1.0);
  }
`;

export const causticsFragmentGLSL = commonConstants + /* glsl */`
  varying vec3 oldPos;
  varying vec3 newPos;
  varying vec3 ray;

  void main() {
    /* if the triangle gets smaller, it gets brighter, and vice versa */
    float oldArea = length(dFdx(oldPos)) * length(dFdy(oldPos));
    float newArea = length(dFdx(newPos)) * length(dFdy(newPos));
    vec4 color = vec4(oldArea / newArea * 0.2, 1.0, 0.0, 0.0);

    vec3 refractedLight = refract(-light, vec3(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);

    /* compute a blob shadow and make sure we only draw a shadow if the player is blocking the light */
    vec3 dir = (sphereCenter - newPos) / sphereRadius;
    vec3 area = cross(dir, refractedLight);
    float shadow = dot(area, area);
    float dist = dot(dir, -refractedLight);
    shadow = 1.0 + (shadow - 1.0) / (0.05 + dist * 0.025);
    shadow = clamp(1.0 / (1.0 + exp(-shadow)), 0.0, 1.0);
    shadow = mix(1.0, shadow, clamp(dist * 2.0, 0.0, 1.0));
    color.g = shadow;

    /* shadow for the rim of the pool */
    vec2 t = intersectCube(newPos, -refractedLight, vec3(-1.0, -poolHeight, -1.0), vec3(1.0, 2.0, 1.0));
    color.r *= 1.0 / (1.0 + exp(-200.0 / (1.0 + 10.0 * (t.y - t.x)) * (newPos.y - refractedLight.y * t.y - 2.0 / 12.0)));

    gl_FragColor = color;
  }
`;
