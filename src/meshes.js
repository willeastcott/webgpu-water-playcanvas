import {
    Mesh, BoundingBox, Vec3, PRIMITIVE_TRIANGLES
} from 'playcanvas';

// Geometry builders that reproduce the meshes from lightgl.js used by the
// original demo. All meshes are authored in the same local space the shaders
// expect, and are given a generous bounding box (their vertex shaders displace
// or remap positions, so per-instance culling is disabled anyway).

const BIG_AABB = new BoundingBox(new Vec3(0, 0, 0), new Vec3(50, 50, 50));

/**
 * A flat grid in the XY plane spanning [-1, 1] with `detail` subdivisions per
 * axis (so detail+1 vertices per axis), z = 0. Matches GL.Mesh.plane.
 * Used for both the water surface and the caustics projection.
 *
 * @param {import('playcanvas').GraphicsDevice} device - The graphics device.
 * @param {number} detail - Subdivisions per axis.
 * @returns {Mesh} The plane mesh.
 */
export function createPlaneMesh(device, detail) {
    const positions = [];
    const indices = [];

    for (let y = 0; y <= detail; y++) {
        const t = y / detail;
        for (let x = 0; x <= detail; x++) {
            const s = x / detail;
            positions.push(2 * s - 1, 2 * t - 1, 0);
            if (x < detail && y < detail) {
                const i = x + y * (detail + 1);
                indices.push(i, i + 1, i + detail + 1);
                indices.push(i + detail + 1, i + 1, i + detail + 2);
            }
        }
    }

    const mesh = new Mesh(device);
    mesh.setPositions(positions);
    mesh.setIndices(indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    mesh.aabb = BIG_AABB;
    return mesh;
}

/**
 * A unit sphere (radius 1) centred at the origin. The sphere shader scales and
 * offsets these positions by the sphere radius/centre, so radius 1 is required.
 *
 * @param {import('playcanvas').GraphicsDevice} device - The graphics device.
 * @param {number} segments - Latitude/longitude segment count.
 * @returns {Mesh} The sphere mesh.
 */
export function createSphereMesh(device, segments) {
    const positions = [];
    const indices = [];

    for (let lat = 0; lat <= segments; lat++) {
        const theta = (lat * Math.PI) / segments;
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);
        for (let lon = 0; lon <= segments; lon++) {
            const phi = (lon * 2 * Math.PI) / segments;
            positions.push(Math.cos(phi) * sinT, cosT, Math.sin(phi) * sinT);
        }
    }

    for (let lat = 0; lat < segments; lat++) {
        for (let lon = 0; lon < segments; lon++) {
            const a = lat * (segments + 1) + lon;
            const b = a + segments + 1;
            indices.push(a, b, a + 1);
            indices.push(a + 1, b, b + 1);
        }
    }

    const mesh = new Mesh(device);
    mesh.setPositions(positions);
    mesh.setIndices(indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    mesh.aabb = BIG_AABB;
    return mesh;
}

// The five interior faces of a [-1,1] cube (the +Y face in cube space is
// omitted; the vertex shader flips Y so it becomes the open top of the pool).
// Corner order and winding match GL.Mesh.cube's cubeData (minus the -y face).
const CUBE_FACES = [
    [[-1, -1, -1], [-1, -1, 1], [-1, 1, -1], [-1, 1, 1]], // -x
    [[1, -1, -1], [1, 1, -1], [1, -1, 1], [1, 1, 1]],      // +x
    [[-1, 1, -1], [-1, 1, 1], [1, 1, -1], [1, 1, 1]],      // +y (-> pool floor after Y remap)
    [[-1, -1, -1], [-1, 1, -1], [1, -1, -1], [1, 1, -1]],  // -z
    [[-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]]       // +z
];

/**
 * The open-topped pool box: a unit cube in [-1,1] with the top face removed.
 * The pool vertex shader remaps Y so the floor is at -poolHeight.
 *
 * @param {import('playcanvas').GraphicsDevice} device - The graphics device.
 * @returns {Mesh} The pool mesh.
 */
export function createPoolMesh(device) {
    const positions = [];
    const indices = [];

    for (let f = 0; f < CUBE_FACES.length; f++) {
        const face = CUBE_FACES[f];
        const v = f * 4;
        for (let j = 0; j < 4; j++) positions.push(face[j][0], face[j][1], face[j][2]);
        indices.push(v, v + 1, v + 2);
        indices.push(v + 2, v + 1, v + 3);
    }

    const mesh = new Mesh(device);
    mesh.setPositions(positions);
    mesh.setIndices(indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    mesh.aabb = BIG_AABB;
    return mesh;
}
