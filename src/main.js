/*
 * WebGL Water, ported to the PlayCanvas Engine.
 *
 * Original WebGL Water by Evan Wallace: http://madebyevan.com/webgl-water/
 * Copyright 2011 Evan Wallace - released under the MIT license.
 *
 * This is a faithful port of the original demo's rendering and simulation to
 * PlayCanvas: a GPU heightfield water sim, real-time caustics, raytraced
 * reflection/refraction off the pool and a draggable sphere, all reproduced
 * with custom GLSL shaders.
 */
import {
    AppBase, AppOptions, Entity, Vec3, Quat, Color,
    RenderComponentSystem, CameraComponentSystem,
    createGraphicsDevice, DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2,
    FILLMODE_FILL_WINDOW, RESOLUTION_AUTO,
    GAMMA_NONE, TONEMAP_NONE
} from 'playcanvas';

import { Water } from './water.js';
import { Renderer } from './renderer.js';
import { createTileTexture, createSkyCubemap } from './assets.js';

const canvas = document.getElementById('application-canvas');

function showError(message) {
    // eslint-disable-next-line no-console
    console.error(message);
    const el = document.getElementById('loading');
    if (el) {
        el.style.display = '';
        el.textContent = String(message);
    }
}
window.addEventListener('unhandledrejection', e => showError(e.reason && e.reason.stack || e.reason));
window.addEventListener('error', e => showError(e.error && e.error.stack || e.message));

// --- Camera orbit state -----------------------------------------------------
// The original demo used a fixed distance; here the scroll wheel zooms within
// a clamped range so you can move in closer without losing the scene.
const CAMERA_TARGET = new Vec3(0, -0.5, 0);
const CAMERA_MIN_DISTANCE = 1.5;
const CAMERA_MAX_DISTANCE = 6;
let cameraDistance = 4;
let angleX = -25;
let angleY = -200.5;

// --- Sphere state -----------------------------------------------------------
const radius = 0.25;
const center = new Vec3(-0.4, -0.75, 0.2);
const oldCenter = center.clone();
const velocity = new Vec3();
const gravity = new Vec3(0, -4, 0);
let useSpherePhysics = false;
let paused = false;

// --- Interaction state ------------------------------------------------------
const MODE_NONE = -1;
const MODE_ADD_DROPS = 0;
const MODE_MOVE_SPHERE = 1;
const MODE_ORBIT_CAMERA = 2;
let mode = MODE_NONE;
let oldX = 0;
let oldY = 0;
const prevHit = new Vec3();
const planeNormal = new Vec3();
let lKeyDown = false;

(async function main() {
    // Prefer WebGPU, fall back to WebGL2. Every shader ships both GLSL (used on
    // WebGL2) and WGSL (used directly on WebGPU), so no runtime GLSL→WGSL
    // transpilation is needed and the glslang/twgsl WASM is not loaded.
    //
    // The backend can be forced from the URL for debugging - ?webgl or ?webgpu -
    // e.g. to check whether a device-specific failure (a black screen on iOS) is
    // WebGPU-only or also reproduces on WebGL2.
    const params = new URLSearchParams(location.search);
    let deviceTypes = [DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2];
    if (params.has('webgl')) deviceTypes = [DEVICETYPE_WEBGL2];
    else if (params.has('webgpu')) deviceTypes = [DEVICETYPE_WEBGPU];

    const device = await createGraphicsDevice(canvas, { deviceTypes });
    device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);
    /* eslint-disable no-console */
    console.log(`Graphics backend: ${device.isWebGPU ? 'WebGPU' : 'WebGL2'}`);

    // The engine surfaces WebGPU errors via Debug.*, which is stripped from the
    // production build - so failures like a silent black screen on iOS leave
    // nothing in the console. Re-surface them ourselves (visible via ?debug).
    if (device.isWebGPU) {
        console.log(`Float RT renderable: ${device.textureFloatRenderable}, filterable: ${device.textureFloatFilterable}`);
        device.wgpu?.addEventListener?.('uncapturederror', (ev) => {
            console.error('WebGPU error:', ev.error?.message ?? ev.error);
        });
    }
    /* eslint-enable no-console */

    const createOptions = new AppOptions();
    createOptions.graphicsDevice = device;
    createOptions.componentSystems = [RenderComponentSystem, CameraComponentSystem];

    const app = new AppBase(canvas);
    app.init(createOptions);
    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);

    const resize = () => app.resizeCanvas();
    window.addEventListener('resize', resize);
    app.on('destroy', () => window.removeEventListener('resize', resize));

    // Load textures (the demo cannot start until the float-RT-capable device
    // and the tile/sky images are ready).
    const [tileTexture, skyCubemap] = await Promise.all([
        createTileTexture(device),
        createSkyCubemap(device)
    ]);

    const water = new Water(device, params.has('half'));
    const renderer = new Renderer(app, tileTexture, skyCubemap);

    // Main camera: fixed-distance orbit, raw (un-tonemapped) output to match
    // the original. The default layer set excludes the custom caustics layer.
    const cameraEntity = new Entity('Camera');
    cameraEntity.addComponent('camera', {
        fov: 45,
        nearClip: 0.01,
        farClip: 100,
        clearColor: new Color(0, 0, 0, 1)
    });
    cameraEntity.camera.gammaCorrection = GAMMA_NONE;
    cameraEntity.camera.toneMapping = TONEMAP_NONE;
    app.root.addChild(cameraEntity);
    const cam = cameraEntity.camera;

    // Seed the surface with some random drops.
    for (let i = 0; i < 20; i++) {
        water.addDrop(Math.random() * 2 - 1, Math.random() * 2 - 1, 0.03, (i & 1) ? 0.01 : -0.01);
    }

    // ----- per-frame update -------------------------------------------------
    app.on('update', (dt) => {
        if (!paused) update(dt);

        // Light tracks the camera while the L key is held.
        if (lKeyDown) {
            fromAngles(renderer.lightDir, (90 - angleY) * Math.PI / 180, -angleX * Math.PI / 180);
        }

        renderer.setSphere(center, radius);
        renderer.update(water, cameraEntity);
        applyCamera();
    });

    // ----- simulation step --------------------------------------------------
    const tmp = new Vec3();
    function update(seconds) {
        if (seconds > 1) return;

        if (mode === MODE_MOVE_SPHERE) {
            // Start from rest when the player releases after dragging the sphere.
            velocity.set(0, 0, 0);
        } else if (useSpherePhysics) {
            const percentUnderWater = Math.max(0, Math.min(1, (radius - center.y) / (2 * radius)));
            // Fall under gravity, reduced by buoyancy while submerged.
            velocity.add(tmp.copy(gravity).mulScalar(seconds - 1.1 * seconds * percentUnderWater));
            // Viscous drag under water.
            const speedSq = velocity.dot(velocity);
            if (speedSq > 0) {
                velocity.sub(tmp.copy(velocity).normalize().mulScalar(percentUnderWater * seconds * speedSq));
            }
            center.add(tmp.copy(velocity).mulScalar(seconds));
            // Bounce off the bottom.
            if (center.y < radius - 1) {
                center.y = radius - 1;
                velocity.y = Math.abs(velocity.y) * 0.7;
            }
        }

        // Displace water around the sphere, then advance the simulation.
        water.moveSphere(oldCenter, center, radius);
        oldCenter.copy(center);

        water.stepSimulation();
        water.stepSimulation();
        water.updateNormals();
    }

    // ----- camera -----------------------------------------------------------
    const _offset = new Vec3();
    const _qx = new Quat();
    const _qy = new Quat();
    const _q = new Quat();
    function applyCamera() {
        _offset.set(0, 0, cameraDistance);
        _qx.setFromAxisAngle(Vec3.RIGHT, angleX);
        _qy.setFromAxisAngle(Vec3.UP, angleY);
        _q.mul2(_qy, _qx);
        _q.transformVector(_offset, _offset);
        cameraEntity.setPosition(
            CAMERA_TARGET.x + _offset.x,
            CAMERA_TARGET.y + _offset.y,
            CAMERA_TARGET.z + _offset.z
        );
        cameraEntity.lookAt(CAMERA_TARGET, Vec3.UP);
    }

    // ----- input ------------------------------------------------------------
    const _eye = new Vec3();
    const _far = new Vec3();
    const _ray = new Vec3();
    const _hit = new Vec3();
    const _t1 = new Vec3();
    const _t2 = new Vec3();

    // Previous water-plane hit while drawing, so drops are swept into a trail.
    let hasDragPoint = false;
    let dragX = 0;
    let dragZ = 0;

    // Builds an eye + (normalised) ray for a canvas pixel. The result is stored
    // in the passed-in vectors to avoid allocation.
    function getRay(px, py, outEye, outRay) {
        outEye.copy(cameraEntity.getPosition());
        cam.screenToWorld(px, py, cam.farClip, _far);
        outRay.copy(_far).sub(outEye).normalize();
    }

    // Ray-sphere intersection; writes the hit point to `out` and returns true.
    function hitTestSphere(eye, ray, c, r, out) {
        const ox = eye.x - c.x, oy = eye.y - c.y, oz = eye.z - c.z;
        const a = ray.dot(ray);
        const b = 2 * (ray.x * ox + ray.y * oy + ray.z * oz);
        const cc = ox * ox + oy * oy + oz * oz - r * r;
        const disc = b * b - 4 * a * cc;
        if (disc > 0) {
            const t = (-b - Math.sqrt(disc)) / (2 * a);
            if (t > 0) {
                out.copy(ray).mulScalar(t).add(eye);
                return true;
            }
        }
        return false;
    }

    function canvasXY(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        return [clientX - rect.left, clientY - rect.top];
    }

    function startDrag(px, py) {
        oldX = px;
        oldY = py;
        hasDragPoint = false;
        getRay(px, py, _eye, _ray);

        if (hitTestSphere(_eye, _ray, center, radius, _hit)) {
            mode = MODE_MOVE_SPHERE;
            prevHit.copy(_hit);
            // Drag plane faces the camera: negated centre-of-screen ray.
            getRay(canvas.clientWidth / 2, canvas.clientHeight / 2, _t1, _t2);
            planeNormal.copy(_t2).mulScalar(-1);
        } else {
            // Intersect the water plane (y = 0).
            const t = -_eye.y / _ray.y;
            const px2 = _eye.x + _ray.x * t;
            const pz2 = _eye.z + _ray.z * t;
            if (Math.abs(px2) < 1 && Math.abs(pz2) < 1) {
                mode = MODE_ADD_DROPS;
                duringDrag(px, py);
            } else {
                mode = MODE_ORBIT_CAMERA;
            }
        }
    }

    function duringDrag(px, py) {
        switch (mode) {
            case MODE_ADD_DROPS: {
                getRay(px, py, _eye, _ray);
                const t = -_eye.y / _ray.y;
                const wx = _eye.x + _ray.x * t;
                const wz = _eye.z + _ray.z * t;
                // Sweep from the previous sample to this one so a fast drag is a
                // continuous trail, not a row of taps; the first sample is a point.
                if (hasDragPoint) {
                    water.addLine(dragX, dragZ, wx, wz, 0.03, 0.01);
                } else {
                    water.addDrop(wx, wz, 0.03, 0.01);
                    hasDragPoint = true;
                }
                dragX = wx;
                dragZ = wz;
                if (paused) water.updateNormals();
                break;
            }
            case MODE_MOVE_SPHERE: {
                getRay(px, py, _eye, _ray);
                const t = -planeNormal.dot(_t1.copy(_eye).sub(prevHit)) / planeNormal.dot(_ray);
                _hit.copy(_ray).mulScalar(t).add(_eye);
                center.add(_t2.copy(_hit).sub(prevHit));
                center.x = Math.max(radius - 1, Math.min(1 - radius, center.x));
                center.y = Math.max(radius - 1, Math.min(10, center.y));
                center.z = Math.max(radius - 1, Math.min(1 - radius, center.z));
                prevHit.copy(_hit);
                break;
            }
            case MODE_ORBIT_CAMERA: {
                angleY -= px - oldX;
                angleX -= py - oldY;
                angleX = Math.max(-89.999, Math.min(89.999, angleX));
                break;
            }
        }
        oldX = px;
        oldY = py;
    }

    function stopDrag() {
        mode = MODE_NONE;
    }

    // Pointer input unifies mouse / touch / pen. Capturing the pointer keeps
    // drag events flowing when it leaves the canvas (so no window-level
    // listeners are needed), and tracking a single active pointer id ignores
    // extra fingers mid-drag. Touch scrolling is suppressed via the canvas's
    // `touch-action: none` CSS.
    let activePointerId = null;

    canvas.addEventListener('pointerdown', (e) => {
        if (activePointerId !== null) return;
        e.preventDefault();
        activePointerId = e.pointerId;
        canvas.setPointerCapture(e.pointerId);
        const [px, py] = canvasXY(e.clientX, e.clientY);
        startDrag(px, py);
    });
    canvas.addEventListener('pointermove', (e) => {
        if (e.pointerId !== activePointerId) return;
        const [px, py] = canvasXY(e.clientX, e.clientY);
        duringDrag(px, py);
    });
    const endPointer = (e) => {
        if (e.pointerId !== activePointerId) return;
        activePointerId = null;
        stopDrag();
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    // Scroll to zoom. Multiplicative steps feel uniform across the range; the
    // result is clamped so the scene can't be lost. preventDefault stops the
    // page from scrolling, so the listener must be non-passive.
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        cameraDistance *= Math.exp(e.deltaY * 0.001);
        cameraDistance = Math.max(CAMERA_MIN_DISTANCE, Math.min(CAMERA_MAX_DISTANCE, cameraDistance));
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
        if (e.key === ' ') {
            paused = !paused;
        } else if (e.key === 'g' || e.key === 'G') {
            useSpherePhysics = !useSpherePhysics;
        } else if (e.key === 'l' || e.key === 'L') {
            lKeyDown = true;
        }
    });
    window.addEventListener('keyup', (e) => {
        if (e.key === 'l' || e.key === 'L') lKeyDown = false;
    });

    // Everything is constructed - position the camera and start rendering.
    applyCamera();
    document.getElementById('loading').style.display = 'none';
    app.start();
})();

/**
 * Direction vector from spherical angles (matches GL.Vector.fromAngles).
 *
 * @param {Vec3} out - Receives the result.
 * @param {number} theta - Azimuth in radians.
 * @param {number} phi - Elevation in radians.
 */
function fromAngles(out, theta, phi) {
    out.set(
        Math.cos(theta) * Math.cos(phi),
        Math.sin(phi),
        Math.sin(theta) * Math.cos(phi)
    );
}
