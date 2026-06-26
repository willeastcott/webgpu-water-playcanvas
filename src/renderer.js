import {
    Entity, MeshInstance, ShaderMaterial, Texture, RenderTarget, Layer, Color, Vec3,
    SEMANTIC_POSITION, CULLFACE_NONE, CULLFACE_BACK, CULLFACE_FRONT,
    PIXELFORMAT_RGBA8, FILTER_LINEAR, ADDRESS_CLAMP_TO_EDGE,
    GAMMA_NONE, TONEMAP_NONE, PROJECTION_ORTHOGRAPHIC
} from 'playcanvas';

import { createPlaneMesh, createSphereMesh, createPoolMesh } from './meshes.js';
import {
    waterVertexGLSL, waterAboveFragmentGLSL, waterBelowFragmentGLSL,
    sphereVertexGLSL, sphereFragmentGLSL,
    cubeVertexGLSL, cubeFragmentGLSL,
    causticsVertexGLSL, causticsFragmentGLSL
} from './shaders/surface.glsl.js';
import {
    waterVertexWGSL, waterAboveFragmentWGSL, waterBelowFragmentWGSL,
    sphereVertexWGSL, sphereFragmentWGSL,
    cubeVertexWGSL, cubeFragmentWGSL,
    causticsVertexWGSL, causticsFragmentWGSL
} from './shaders/surface.wgsl.js';

const CAUSTICS_SIZE = 1024;
const WATER_DETAIL = 200;

function makeMaterial(name, vertexGLSL, fragmentGLSL, vertexWGSL, fragmentWGSL, cull) {
    const material = new ShaderMaterial({
        uniqueName: name,
        vertexGLSL,
        fragmentGLSL,
        vertexWGSL,
        fragmentWGSL,
        attributes: { aPosition: SEMANTIC_POSITION }
    });
    material.cull = cull;
    material.update();
    return material;
}

/**
 * Owns every visible material and the caustics pass. The pool, water surface
 * (rendered twice, for the above- and below-water views) and sphere are drawn
 * by the app's main camera; the caustics texture is produced by a dedicated
 * camera that rasterises the projected water mesh into an off-screen target.
 */
export class Renderer {
    /**
     * @param {import('playcanvas').AppBase} app - The application.
     * @param {Texture} tileTexture - The repeating pool tile texture.
     * @param {Texture} skyCubemap - The sky cubemap for reflections.
     */
    constructor(app, tileTexture, skyCubemap) {
        this.app = app;
        const device = app.graphicsDevice;

        this.tileTexture = tileTexture;
        this.skyCubemap = skyCubemap;
        this.lightDir = new Vec3(2.0, 2.0, -1.0).normalize();
        this.sphereCenter = new Vec3();
        this.sphereRadius = 0;

        // Caustics render targets, double-buffered: each frame the caustics
        // camera writes one buffer while the scene samples the other (written
        // last frame). This avoids writing and sampling a single texture in the
        // same frame, which WebGPU rejects as a read/write hazard. A one-frame
        // old caustics map is visually imperceptible.
        const makeCaustic = (i) => {
            const texture = new Texture(device, {
                name: `caustics${i}`,
                width: CAUSTICS_SIZE,
                height: CAUSTICS_SIZE,
                format: PIXELFORMAT_RGBA8,
                mipmaps: false,
                minFilter: FILTER_LINEAR,
                magFilter: FILTER_LINEAR,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
            const target = new RenderTarget({
                name: `causticsRT${i}`, colorBuffer: texture, depth: false, flipY: false
            });
            return { texture, target };
        };
        this._caustics = [makeCaustic(0), makeCaustic(1)];
        this._causticIndex = 0;
        // The texture currently being sampled by the scene (updated each frame).
        this.causticTexture = this._caustics[0].texture;

        // Shared meshes (the water surface and caustics use the same grid).
        const planeMesh = createPlaneMesh(device, WATER_DETAIL);
        const sphereMesh = createSphereMesh(device, 32);
        const poolMesh = createPoolMesh(device);

        // Materials. Cull modes mirror the original draw calls.
        this.poolMaterial = makeMaterial('pool', cubeVertexGLSL, cubeFragmentGLSL, cubeVertexWGSL, cubeFragmentWGSL, CULLFACE_BACK);
        this.waterAboveMaterial = makeMaterial('waterAbove', waterVertexGLSL, waterAboveFragmentGLSL, waterVertexWGSL, waterAboveFragmentWGSL, CULLFACE_FRONT);
        this.waterBelowMaterial = makeMaterial('waterBelow', waterVertexGLSL, waterBelowFragmentGLSL, waterVertexWGSL, waterBelowFragmentWGSL, CULLFACE_BACK);
        this.sphereMaterial = makeMaterial('sphere', sphereVertexGLSL, sphereFragmentGLSL, sphereVertexWGSL, sphereFragmentWGSL, CULLFACE_NONE);

        this.causticsMaterial = makeMaterial('caustics', causticsVertexGLSL, causticsFragmentGLSL, causticsVertexWGSL, causticsFragmentWGSL, CULLFACE_NONE);
        this.causticsMaterial.depthTest = false;
        this.causticsMaterial.depthWrite = false;

        this.sceneMaterials = [
            this.poolMaterial, this.waterAboveMaterial, this.waterBelowMaterial, this.sphereMaterial
        ];

        // Layers: visible meshes on the default World layer; the caustics mesh
        // on its own layer rendered only by the caustics camera.
        const worldLayer = app.scene.layers.getLayerByName('World');
        this.causticsLayer = new Layer({ name: 'Caustics' });
        app.scene.layers.insert(this.causticsLayer, 0);

        const addMesh = (mesh, material, layerId) => {
            const mi = new MeshInstance(mesh, material);
            mi.cull = false;
            const entity = new Entity();
            entity.addComponent('render', {
                type: 'asset',
                meshInstances: [mi],
                castShadows: false,
                receiveShadows: false,
                layers: [layerId]
            });
            app.root.addChild(entity);
            return entity;
        };

        addMesh(poolMesh, this.poolMaterial, worldLayer.id);
        addMesh(planeMesh, this.waterAboveMaterial, worldLayer.id);
        addMesh(planeMesh, this.waterBelowMaterial, worldLayer.id);
        this.sphereEntity = addMesh(sphereMesh, this.sphereMaterial, worldLayer.id);
        addMesh(planeMesh, this.causticsMaterial, this.causticsLayer.id);

        // Caustics camera: renders only the caustics layer into the target.
        // The caustics vertex shader emits clip-space positions directly, so the
        // camera's projection is irrelevant - it only triggers the pass.
        this.causticsCamera = new Entity('CausticsCamera');
        this.causticsCamera.addComponent('camera', {
            layers: [this.causticsLayer.id],
            renderTarget: this._caustics[0].target,
            clearColor: new Color(0, 0, 0, 0),
            clearDepthBuffer: false,
            clearStencilBuffer: false,
            priority: -10,
            projection: PROJECTION_ORTHOGRAPHIC
        });
        this.causticsCamera.camera.gammaCorrection = GAMMA_NONE;
        this.causticsCamera.camera.toneMapping = TONEMAP_NONE;
        app.root.addChild(this.causticsCamera);

        // Reusable uniform scratch.
        this._light = new Float32Array(3);
        this._center = new Float32Array(3);
        this._eye = new Float32Array(3);
    }

    setSphere(center, radius) {
        this.sphereCenter.copy(center);
        this.sphereRadius = radius;
        this.sphereEntity.enabled = radius > 0;
    }

    /**
     * Push the current frame's uniforms onto every material. Called each frame
     * before the cameras render, so both the caustics pass and the main scene
     * read consistent state.
     *
     * @param {import('./water.js').Water} water - The water simulation.
     * @param {Entity} cameraEntity - The main camera entity.
     */
    update(water, cameraEntity) {
        const l = this.lightDir;
        this._light[0] = l.x; this._light[1] = l.y; this._light[2] = l.z;
        const c = this.sphereCenter;
        this._center[0] = c.x; this._center[1] = c.y; this._center[2] = c.z;
        const e = cameraEntity.getPosition();
        this._eye[0] = e.x; this._eye[1] = e.y; this._eye[2] = e.z;

        const waterTex = water.textureA;

        // Ping-pong the caustics buffers: render into one, sample the other.
        this._causticIndex ^= 1;
        const write = this._caustics[this._causticIndex];
        const read = this._caustics[this._causticIndex ^ 1];
        this.causticsCamera.camera.renderTarget = write.target;
        this.causticTexture = read.texture;

        // Caustics material needs the simulation state and light only.
        const cm = this.causticsMaterial;
        cm.setParameter('light', this._light);
        cm.setParameter('sphereCenter', this._center);
        cm.setParameter('sphereRadius', this.sphereRadius);
        cm.setParameter('water', waterTex);

        // Visible materials need the full set (extra params on shaders that do
        // not declare them are simply ignored).
        for (const m of this.sceneMaterials) {
            m.setParameter('light', this._light);
            m.setParameter('sphereCenter', this._center);
            m.setParameter('sphereRadius', this.sphereRadius);
            m.setParameter('water', waterTex);
            m.setParameter('tiles', this.tileTexture);
            m.setParameter('causticTex', read.texture);
            m.setParameter('sky', this.skyCubemap);
            m.setParameter('eye', this._eye);
        }
    }
}
