// GPGPU water-simulation passes. Each runs as a full-screen quad over the
// 256x256 ping-pong heightmap. The texture channels are:
//   R = water height, G = vertical velocity, B = normal.x, A = normal.z
//
// Ported from Evan Wallace's water.js. The only changes from the original:
//  - `gl_Vertex` -> `aPosition` (a vec2 supplied by the engine's quad vertex
//    buffer, in clip space [-1, 1]).
//  - the input sampler is named `uSource` instead of `texture` (the latter is
//    a reserved word in GLSL ES 3.00, which the engine targets).

// Shared vertex shader: passes a [0,1] coordinate to the fragment stage and
// draws a clip-space-filling quad. Matches the original 1:1 (no Y flip), so
// the texel<->world mapping is identical to madebyevan.com/webgl-water.
export const simVertexGLSL = /* glsl */`
  attribute vec2 aPosition;
  varying vec2 coord;
  void main() {
    coord = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

// Initialise the heightmap to zero. Used in place of a backend-specific render
// target clear (WebGPU has no updateBegin/clear path), and works on both
// backends via drawQuadWithShader.
export const clearFragmentGLSL = /* glsl */`
  void main() {
    gl_FragColor = vec4(0.0);
  }
`;

// Add an interactive ripple: a raised-cosine bump swept along the segment
// center -> center2, so a dragged pointer leaves a continuous trail. When the
// two endpoints are equal it collapses to the original single point drop.
export const dropFragmentGLSL = /* glsl */`
  const float PI = 3.141592653589793;
  uniform sampler2D uSource;
  uniform vec2 center;
  uniform vec2 center2;
  uniform float radius;
  uniform float strength;
  varying vec2 coord;
  void main() {
    /* get vertex info */
    vec4 info = texture2D(uSource, coord);

    /* distance from this texel to the drag segment (center -> center2) */
    vec2 a = center * 0.5 + 0.5;
    vec2 b = center2 * 0.5 + 0.5;
    vec2 pa = coord - a;
    vec2 ba = b - a;
    float denom = dot(ba, ba);
    float h = denom > 0.0 ? clamp(dot(pa, ba) / denom, 0.0, 1.0) : 0.0;

    /* add the raised-cosine ripple along that segment */
    float drop = max(0.0, 1.0 - length(pa - ba * h) / radius);
    drop = 0.5 - cos(drop * PI) * 0.5;
    info.r += drop * strength;

    gl_FragColor = info;
  }
`;

// Advance the wave equation one step (4-neighbour Laplacian + damping).
export const updateFragmentGLSL = /* glsl */`
  uniform sampler2D uSource;
  uniform vec2 delta;
  varying vec2 coord;
  void main() {
    /* get vertex info */
    vec4 info = texture2D(uSource, coord);

    /* calculate average neighbor height */
    vec2 dx = vec2(delta.x, 0.0);
    vec2 dy = vec2(0.0, delta.y);
    float average = (
      texture2D(uSource, coord - dx).r +
      texture2D(uSource, coord - dy).r +
      texture2D(uSource, coord + dx).r +
      texture2D(uSource, coord + dy).r
    ) * 0.25;

    /* change the velocity to move toward the average */
    info.g += (average - info.r) * 2.0;

    /* attenuate the velocity a little so waves do not last forever */
    info.g *= 0.995;

    /* move the vertex along the velocity */
    info.r += info.g;

    gl_FragColor = info;
  }
`;

// Recompute the surface normal (stored in BA) from height derivatives.
export const normalFragmentGLSL = /* glsl */`
  uniform sampler2D uSource;
  uniform vec2 delta;
  varying vec2 coord;
  void main() {
    /* get vertex info */
    vec4 info = texture2D(uSource, coord);

    /* update the normal */
    vec3 dx = vec3(delta.x, texture2D(uSource, vec2(coord.x + delta.x, coord.y)).r - info.r, 0.0);
    vec3 dy = vec3(0.0, texture2D(uSource, vec2(coord.x, coord.y + delta.y)).r - info.r, delta.y);
    info.ba = normalize(cross(dy, dx)).xz;

    gl_FragColor = info;
  }
`;

// Displace water as the sphere moves: add the volume it vacated at oldCenter
// and subtract the volume it now occupies at newCenter.
export const sphereFragmentGLSL = /* glsl */`
  uniform sampler2D uSource;
  uniform vec3 oldCenter;
  uniform vec3 newCenter;
  uniform float radius;
  varying vec2 coord;

  float volumeInSphere(vec3 center) {
    vec3 toCenter = vec3(coord.x * 2.0 - 1.0, 0.0, coord.y * 2.0 - 1.0) - center;
    float t = length(toCenter) / radius;
    float dy = exp(-pow(t * 1.5, 6.0));
    float ymin = min(0.0, center.y - dy);
    float ymax = min(max(0.0, center.y + dy), ymin + 2.0 * dy);
    return (ymax - ymin) * 0.1;
  }

  void main() {
    /* get vertex info */
    vec4 info = texture2D(uSource, coord);

    /* add the old volume */
    info.r += volumeInSphere(oldCenter);

    /* subtract the new volume */
    info.r -= volumeInSphere(newCenter);

    gl_FragColor = info;
  }
`;
