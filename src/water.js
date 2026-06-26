import {
    Texture, RenderTarget, ShaderUtils, drawQuadWithShader,
    SEMANTIC_POSITION,
    PIXELFORMAT_RGBA32F, PIXELFORMAT_RGBA16F,
    FILTER_LINEAR, ADDRESS_CLAMP_TO_EDGE
} from 'playcanvas';

import {
    simVertexGLSL, clearFragmentGLSL, dropFragmentGLSL, updateFragmentGLSL,
    normalFragmentGLSL, sphereFragmentGLSL
} from './shaders/simulation.glsl.js';
import {
    simVertexWGSL, clearFragmentWGSL, dropFragmentWGSL, updateFragmentWGSL,
    normalFragmentWGSL, sphereFragmentWGSL
} from './shaders/simulation.wgsl.js';

const SIZE = 256;

/**
 * Interactive heightfield water simulation on a double-buffered (ping-pong)
 * floating-point render target. Channel layout per texel:
 *   R = height, G = vertical velocity, B = normal.x, A = normal.z
 *
 * Direct port of Evan Wallace's water.js: each operation renders a full-screen
 * quad that reads the current texture (`uSource`) and writes the next, then the
 * two buffers are swapped.
 */
export class Water {
    constructor(device, forceHalfFloat = false) {
        this.device = device;

        // Use 32-bit float only when the device can also FILTER it. iOS reports
        // rgba32float as renderable but NOT filterable, and a non-filterable
        // float texture view can't bind to the shaders' filtering sampler, so
        // createBindGroup fails on WebGPU and the scene is blank. 16-bit float
        // is renderable and filterable everywhere we target, so it's the safe
        // fallback. (?half forces it, to exercise this path on desktop.)
        const useFloat32 = !forceHalfFloat && device.textureFloatRenderable && device.textureFloatFilterable;
        const format = useFloat32 ? PIXELFORMAT_RGBA32F : PIXELFORMAT_RGBA16F;
        const filter = FILTER_LINEAR;

        const makeTexture = (name) => new Texture(device, {
            name,
            width: SIZE,
            height: SIZE,
            format,
            mipmaps: false,
            minFilter: filter,
            magFilter: filter,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });

        this.textureA = makeTexture('WaterA');
        this.textureB = makeTexture('WaterB');
        this.targetA = new RenderTarget({ name: 'WaterRTA', colorBuffer: this.textureA, depth: false, flipY: false });
        this.targetB = new RenderTarget({ name: 'WaterRTB', colorBuffer: this.textureB, depth: false, flipY: false });

        const attributes = { aPosition: SEMANTIC_POSITION };
        const makeShader = (name, frag, fragWGSL) => ShaderUtils.createShader(device, {
            uniqueName: name,
            attributes,
            vertexGLSL: simVertexGLSL,
            fragmentGLSL: frag,
            vertexWGSL: simVertexWGSL,
            fragmentWGSL: fragWGSL
        });

        this.clearShader = makeShader('WaterClear', clearFragmentGLSL, clearFragmentWGSL);
        this.dropShader = makeShader('WaterDrop', dropFragmentGLSL, dropFragmentWGSL);
        this.updateShader = makeShader('WaterUpdate', updateFragmentGLSL, updateFragmentWGSL);
        this.normalShader = makeShader('WaterNormal', normalFragmentGLSL, normalFragmentWGSL);
        this.sphereShader = makeShader('WaterSphere', sphereFragmentGLSL, sphereFragmentWGSL);

        this._delta = new Float32Array([1 / SIZE, 1 / SIZE]);
        this._center = new Float32Array(2);
        this._center2 = new Float32Array(2);
        this._old = new Float32Array(3);
        this._new = new Float32Array(3);

        this._resolveUSource = device.scope.resolve('uSource');

        this.clear();
    }

    /** Zero both buffers so the very first simulation step reads clean state. */
    clear() {
        drawQuadWithShader(this.device, this.targetA, this.clearShader);
        drawQuadWithShader(this.device, this.targetB, this.clearShader);
    }

    _swap() {
        let t = this.textureA; this.textureA = this.textureB; this.textureB = t;
        t = this.targetA; this.targetA = this.targetB; this.targetB = t;
    }

    /** Run `shader` reading textureA, writing textureB, then swap. */
    _pass(shader) {
        this._resolveUSource.setValue(this.textureA);
        drawQuadWithShader(this.device, this.targetB, shader);
        this._swap();
    }

    /** Add a circular ripple centred at simulation coords (x, y) in [-1, 1]. */
    addDrop(x, y, radius, strength) {
        this.addLine(x, y, x, y, radius, strength);
    }

    /**
     * Add a ripple swept along the segment (x0, y0) -> (x1, y1) in [-1, 1] so a
     * dragged pointer leaves a continuous trail instead of separate drops. A
     * zero-length segment is a single drop (see `addDrop`).
     */
    addLine(x0, y0, x1, y1, radius, strength) {
        const { device } = this;
        this._center[0] = x0;
        this._center[1] = y0;
        this._center2[0] = x1;
        this._center2[1] = y1;
        device.scope.resolve('center').setValue(this._center);
        device.scope.resolve('center2').setValue(this._center2);
        device.scope.resolve('radius').setValue(radius);
        device.scope.resolve('strength').setValue(strength);
        this._pass(this.dropShader);
    }

    /** Displace water for a sphere moving from oldCenter to newCenter (pc.Vec3). */
    moveSphere(oldCenter, newCenter, radius) {
        const { device } = this;
        this._old[0] = oldCenter.x; this._old[1] = oldCenter.y; this._old[2] = oldCenter.z;
        this._new[0] = newCenter.x; this._new[1] = newCenter.y; this._new[2] = newCenter.z;
        device.scope.resolve('oldCenter').setValue(this._old);
        device.scope.resolve('newCenter').setValue(this._new);
        device.scope.resolve('radius').setValue(radius);
        this._pass(this.sphereShader);
    }

    /** Advance the wave equation by one step. */
    stepSimulation() {
        this.device.scope.resolve('delta').setValue(this._delta);
        this._pass(this.updateShader);
    }

    /** Recompute surface normals from the current heightfield. */
    updateNormals() {
        this.device.scope.resolve('delta').setValue(this._delta);
        this._pass(this.normalShader);
    }
}
