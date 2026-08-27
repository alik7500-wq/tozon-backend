import fs from 'fs';
import path from 'path';

/**
 * Creates a multi-unit 3D floor layout GLB binary file
 * representing the real 7-unit floor plan of Block A (Floor 2).
 */
export function createPilotFloorGLB() {
  // Boxes configuration for the 7 units arranged along a floor slab
  // Each unit has distinct (x, y, z) bounds
  const unitBoxes = [
    { name: 'APT_A_1_02_001', min: [-12, 0, -4], max: [-8, 3, 4], color: [0.2, 0.6, 0.9, 1.0] },
    { name: 'APT_A_1_02_002', min: [-8, 0, -4], max: [-4, 3, 4], color: [0.3, 0.7, 0.4, 1.0] },
    { name: 'APT_A_1_02_003', min: [-4, 0, -4], max: [-1, 3, 4], color: [0.9, 0.6, 0.2, 1.0] },
    { name: 'APT_A_1_02_004', min: [-1, 0, -4], max: [2, 3, 4], color: [0.8, 0.3, 0.7, 1.0] },
    { name: 'APT_A_1_02_005', min: [2, 0, -4], max: [6, 3, 4], color: [0.2, 0.8, 0.8, 1.0] },
    { name: 'APT_A_1_02_006', min: [6, 0, -4], max: [9, 3, 4], color: [0.9, 0.4, 0.4, 1.0] },
    { name: 'APT_A_1_02_007', min: [9, 0, -4], max: [12, 3, 4], color: [0.5, 0.5, 0.9, 1.0] },
    // Building floor base
    { name: 'FLR_A_02_SLAB', min: [-13, -0.4, -5], max: [13, 0, 5], color: [0.2, 0.25, 0.3, 1.0] },
    // Decorative entrance canopy (unmapped decorative mesh)
    { name: 'DECOR_ENTRANCE_CANOPY', min: [-2, -0.4, 5], max: [2, 1.5, 8], color: [0.7, 0.7, 0.7, 1.0] }
  ];

  function makeBoxVertices(min, max) {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    return new Float32Array([
      // Front
      x0, y0, z1,   x1, y0, z1,   x1, y1, z1,   x0, y1, z1,
      // Back
      x0, y0, z0,   x0, y1, z0,   x1, y1, z0,   x1, y0, z0,
      // Top
      x0, y1, z0,   x0, y1, z1,   x1, y1, z1,   x1, y1, z0,
      // Bottom
      x0, y0, z0,   x1, y0, z0,   x1, y0, z1,   x0, y0, z1,
      // Right
      x1, y0, z0,   x1, y1, z0,   x1, y1, z1,   x1, y0, z1,
      // Left
      x0, y0, z0,   x0, y0, z1,   x0, y1, z1,   x0, y1, z0
    ]);
  }

  const boxIndices = new Uint16Array([
     0,  1,  2,   0,  2,  3, // Front
     4,  5,  6,   4,  6,  7, // Back
     8,  9, 10,   8, 10, 11, // Top
    12, 13, 14,  12, 14, 15, // Bottom
    16, 17, 18,  16, 18, 19, // Right
    20, 21, 22,  20, 22, 23  // Left
  ]);

  const buffersList = [];
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
  const materials = [];

  let currentByteOffset = 0;

  unitBoxes.forEach((box, i) => {
    const posData = makeBoxVertices(box.min, box.max);
    const posBuf = Buffer.from(posData.buffer);
    const idxBuf = Buffer.from(boxIndices.buffer);

    // Positions bufferView
    bufferViews.push({
      buffer: 0,
      byteOffset: currentByteOffset,
      byteLength: posBuf.length,
      target: 34962 // ARRAY_BUFFER
    });
    const posViewIndex = bufferViews.length - 1;
    currentByteOffset += posBuf.length;
    buffersList.push(posBuf);

    // Indices bufferView
    bufferViews.push({
      buffer: 0,
      byteOffset: currentByteOffset,
      byteLength: idxBuf.length,
      target: 34963 // ELEMENT_ARRAY_BUFFER
    });
    const idxViewIndex = bufferViews.length - 1;
    currentByteOffset += idxBuf.length;
    buffersList.push(idxBuf);

    // Position Accessor
    accessors.push({
      bufferView: posViewIndex,
      byteOffset: 0,
      componentType: 5126, // FLOAT
      count: 24,
      type: 'VEC3',
      min: box.min,
      max: box.max
    });
    const posAccIndex = accessors.length - 1;

    // Index Accessor
    accessors.push({
      bufferView: idxViewIndex,
      byteOffset: 0,
      componentType: 5123, // UNSIGNED_SHORT
      count: 36,
      type: 'SCALAR',
      min: [0],
      max: [23]
    });
    const idxAccIndex = accessors.length - 1;

    // Material
    materials.push({
      name: `Material_${box.name}`,
      pbrMetallicRoughness: {
        baseColorFactor: box.color,
        metallicFactor: 0.1,
        roughnessFactor: 0.7
      }
    });
    const matIndex = materials.length - 1;

    // Mesh
    meshes.push({
      name: box.name,
      primitives: [{
        attributes: { POSITION: posAccIndex },
        indices: idxAccIndex,
        material: matIndex
      }]
    });

    // Node
    nodes.push({
      name: box.name,
      mesh: i
    });
  });

  const binBuffer = Buffer.concat(buffersList);

  const gltf = {
    asset: { version: '2.0', generator: 'TOZON-CRM Pilot BIM Generator' },
    scenes: [{ nodes: nodes.map((_, idx) => idx) }],
    scene: 0,
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binBuffer.length }]
  };

  let jsonStr = JSON.stringify(gltf);
  while (Buffer.byteLength(jsonStr, 'utf8') % 4 !== 0) {
    jsonStr += ' ';
  }
  const jsonBuffer = Buffer.from(jsonStr, 'utf8');

  // Binary padding for bin buffer
  let binPadded = binBuffer;
  const binPadding = (4 - (binBuffer.length % 4)) % 4;
  if (binPadding > 0) {
    binPadded = Buffer.concat([binBuffer, Buffer.alloc(binPadding, 0)]);
  }

  // GLB Header: 12 bytes
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546C67, 0); // 'glTF'
  header.writeUInt32LE(2, 4); // version 2
  const totalLength = 12 + 8 + jsonBuffer.length + 8 + binPadded.length;
  header.writeUInt32LE(totalLength, 8);

  // Chunk 0: JSON
  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonBuffer.length, 0);
  jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4); // 'JSON'

  // Chunk 1: BIN
  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binPadded.length, 0);
  binChunkHeader.writeUInt32LE(0x004E4942, 4); // 'BIN\0'

  return Buffer.concat([
    header,
    jsonChunkHeader,
    jsonBuffer,
    binChunkHeader,
    binPadded
  ]);
}

if (process.argv[1] && process.argv[1].endsWith('generate_pilot_floor_glb.js')) {
  const glb = createPilotFloorGLB();
  const outPath = path.resolve('pilot_block_a_floor_2.glb');
  fs.writeFileSync(outPath, glb);
  console.log(`Successfully generated Pilot Floor GLB at ${outPath} (${glb.length} bytes)`);
}
