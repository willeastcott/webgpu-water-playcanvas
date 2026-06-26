import {
    Texture, RenderTarget, ShaderUtils, drawQuadWithShader,
    SEMANTIC_POSITION,
    PIXELFORMAT_RGBA32F, PIXELFORMAT_RGBA16F,
    FILTER_LINEAR, FILTER_NEAREST, ADDRESS_CLAMP_TO_EDGE
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
    constructor(device) {
        this.device = device;

        // Prefer full 32-bit float; fall back to 16-bit half-float (e.g. iOS).
        // Half-float is linear-filterable by default on WebGL2; full float needs
        // the explicit capability.
        const useFloat = device.textureFloatRenderable;
        const format = useFloat ? PIXELFORMAT_RGBA32F : PIXELFORMAT_RGBA16F;
        const filterable = useFloat ? device.textureFloatFilterable : true;
        const filter = filterable ? FILTER_LINEAR : FILTER_NEAREST;

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
        const { device } = this;
        this._center[0] = x;
        this._center[1] = y;
        device.scope.resolve('center').setValue(this._center);
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
