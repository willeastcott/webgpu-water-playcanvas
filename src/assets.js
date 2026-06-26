import {
    Texture,
    PIXELFORMAT_RGBA8,
    FILTER_LINEAR, FILTER_LINEAR_MIPMAP_LINEAR,
    ADDRESS_CLAMP_TO_EDGE, ADDRESS_REPEAT
} from 'playcanvas';

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load ${url}`));
        img.src = url;
    });
}

// WebGPU does not accept an HTMLImageElement as a texture source (only
// ImageBitmap / canvas / video). ImageBitmap is also valid on WebGL2, so we
// decode to a bitmap on both backends.
async function loadBitmap(url) {
    return createImageBitmap(await loadImage(url));
}

/**
 * The repeating pool tile texture (mip-mapped, repeat-wrapped).
 *
 * @param {import('playcanvas').GraphicsDevice} device - The graphics device.
 * @returns {Promise<Texture>} The tile texture.
 */
export async function createTileTexture(device) {
    const bitmap = await loadBitmap('tiles.jpg');
    const texture = new Texture(device, {
        name: 'tiles',
        width: bitmap.width,
        height: bitmap.height,
        format: PIXELFORMAT_RGBA8,
        mipmaps: true,
        minFilter: FILTER_LINEAR_MIPMAP_LINEAR,
        magFilter: FILTER_LINEAR,
        addressU: ADDRESS_REPEAT,
        addressV: ADDRESS_REPEAT
    });
    texture.setSource(bitmap);
    return texture;
}

/**
 * Builds the sky cubemap sampled for reflections by the water surface.
 * There is no -Y (ground) face in the original asset set, so +Y is reused for
 * both poles, exactly as the original demo does.
 *
 * @param {import('playcanvas').GraphicsDevice} device - The graphics device.
 * @returns {Promise<Texture>} The cubemap texture.
 */
export async function createSkyCubemap(device) {
    const [xpos, xneg, ypos, zpos, zneg] = await Promise.all(
        ['xpos.jpg', 'xneg.jpg', 'ypos.jpg', 'zpos.jpg', 'zneg.jpg'].map(loadBitmap)
    );

    const cubemap = new Texture(device, {
        name: 'sky',
        cubemap: true,
        width: xpos.width,
        height: xpos.height,
        format: PIXELFORMAT_RGBA8,
        mipmaps: false,
        minFilter: FILTER_LINEAR,
        magFilter: FILTER_LINEAR,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE
    });

    // PlayCanvas cube face order: [+X, -X, +Y, -Y, +Z, -Z].
    cubemap.setSource([xpos, xneg, ypos, ypos, zpos, zneg]);

    return cubemap;
}
