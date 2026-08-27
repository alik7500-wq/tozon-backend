import fs from 'fs';
import path from 'path';

export function createSampleGLB() {
  // Simple building cube with 2 apartment volumes
  // Mesh 1: APT_A_1_02_001 (Unit #1)
  // Mesh 2: APT_A_1_02_002 (Unit #2)
  // Mesh 3: BUILDING_ROOF

  // Define 8 vertices for a box (position float32 x 3)
  // Unit 1 box vertices [-2, 0, -2] to [0, 3, 2]
  // Unit 2 box vertices [0, 0, -2] to [2, 3, 2]

  const box1Positions = new Float32Array([
    -2, 0,  2,   0, 0,  2,   0, 3,  2,  -2, 3,  2, // Front
    -2, 0, -2,  -2, 3, -2,   0, 3, -2,   0, 0, -2, // Back
    -2, 3, -2,  -2, 3,  2,   0, 3,  2,   0, 3, -2, // Top
    -2, 0, -2,   0, 0, -2,   0, 0,  2,  -2, 0,  2, // Bottom
     0, 0, -2,   0, 3, -2,   0, 3,  2,   0, 0,  2, // Right
    -2, 0, -2,  -2, 0,  2,  -2, 3,  2,  -2, 3, -2  // Left
  ]);

  const box2Positions = new Float32Array([
     0, 0,  2,   2, 0,  2,   2, 3,  2,   0, 3,  2, // Front
     0, 0, -2,   0, 3, -2,   2, 3, -2,   2, 0, -2, // Back
     0, 3, -2,   0, 3,  2,   2, 3,  2,   2, 3, -2, // Top
     0, 0, -2,   2, 0, -2,   2, 0,  2,   0, 0,  2, // Bottom
     2, 0, -2,   2, 3, -2,   2, 3,  2,   2, 0,  2, // Right
     0, 0, -2,   0, 0,  2,   0, 3,  2,   0, 3, -2  // Left
  ]);

  const boxIndices = new Uint16Array([
     0,  1,  2,   0,  2,  3, // Front
     4,  5,  6,   4,  6,  7, // Back
     8,  9, 10,   8, 10, 11, // Top
    12, 13, 14,  12, 14, 15, // Bottom
    16, 17, 18,  16, 18, 19, // Right
    20, 21, 22,  20, 22, 23  // Left
  ]);

  // Combine binary buffers
  const buf1Pos = Buffer.from(box1Positions.buffer);
  const buf1Idx = Buffer.from(boxIndices.buffer);
  const buf2Pos = Buffer.from(box2Positions.buffer);
  const buf2Idx = Buffer.from(boxIndices.buffer);

  // Total buffer length
  const totalBinLength = buf1Pos.length + buf1Idx.length + buf2Pos.length + buf2Idx.length;
  const binBuffer = Buffer.concat([buf1Pos, buf1Idx, buf2Pos, buf2Idx]);

  // JSON Manifest
  const gltf = {
    asset: { version: '2.0', generator: 'TOZON-3D-Engine' },
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
    nodes: [
      { name: 'APT_A_1_02_001', mesh: 0 },
      { name: 'APT_A_1_02_002', mesh: 1 }
    ],
    meshes: [
      {
        name: 'APT_A_1_02_001',
        primitives: [{
          attributes: { POSITION: 0 },
          indices: 1,
          material: 0
        }]
      },
      {
        name: 'APT_A_1_02_002',
        primitives: [{
          attributes: { POSITION: 2 },
          indices: 3,
          material: 1
        }]
      }
    ],
    materials: [
      {
        name: 'Material_Unit_1',
        pbrMetallicRoughness: {
          baseColorFactor: [0.2, 0.6, 0.9, 1.0],
          metallicFactor: 0.1,
          roughnessFactor: 0.8
        }
      },
      {
        name: 'Material_Unit_2',
        pbrMetallicRoughness: {
          baseColorFactor: [0.9, 0.5, 0.2, 1.0],
          metallicFactor: 0.1,
          roughnessFactor: 0.8
        }
      }
    ],
    accessors: [
      // 0: Box 1 Positions
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: 24,
        type: 'VEC3',
        max: [0, 3, 2],
        min: [-2, 0, -2]
      },
      // 1: Box 1 Indices
      {
        bufferView: 1,
        byteOffset: 0,
        componentType: 5123, // UNSIGNED_SHORT
        count: 36,
        type: 'SCALAR',
        max: [23],
        min: [0]
      },
      // 2: Box 2 Positions
      {
        bufferView: 2,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: 24,
        type: 'VEC3',
        max: [2, 3, 2],
        min: [0, 0, -2]
      },
      // 3: Box 2 Indices
      {
        bufferView: 3,
        byteOffset: 0,
        componentType: 5123, // UNSIGNED_SHORT
        count: 36,
        type: 'SCALAR',
        max: [23],
        min: [0]
      }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: buf1Pos.length, target: 34962 },
      { buffer: 0, byteOffset: buf1Pos.length, byteLength: buf1Idx.length, target: 34963 },
      { buffer: 0, byteOffset: buf1Pos.length + buf1Idx.length, byteLength: buf2Pos.length, target: 34962 },
      { buffer: 0, byteOffset: buf1Pos.length + buf1Idx.length + buf2Pos.length, byteLength: buf2Idx.length, target: 34963 }
    ],
    buffers: [{ byteLength: totalBinLength }]
  };

  let jsonStr = JSON.stringify(gltf);
  // Pad JSON string with spaces to align to 4 bytes
  while (Buffer.byteLength(jsonStr, 'utf8') % 4 !== 0) {
    jsonStr += ' ';
  }
  const jsonBuf = Buffer.from(jsonStr, 'utf8');

  // Pad Binary buffer to 4 bytes
  let paddedBin = binBuffer;
  const binPadding = (4 - (binBuffer.length % 4)) % 4;
  if (binPadding > 0) {
    paddedBin = Buffer.concat([binBuffer, Buffer.alloc(binPadding)]);
  }

  // GLB Total Length = 12 (Header) + 8 (JSON Chunk Header) + jsonBuf.length + 8 (BIN Chunk Header) + paddedBin.length
  const totalLength = 12 + 8 + jsonBuf.length + 8 + paddedBin.length;
  const glbBuffer = Buffer.alloc(totalLength);

  // 1. GLB Header (12 bytes)
  glbBuffer.writeUInt32LE(0x46546C67, 0); // Magic: 'glTF'
  glbBuffer.writeUInt32LE(2, 4);          // Version: 2
  glbBuffer.writeUInt32LE(totalLength, 8);// Total length

  // 2. Chunk 0: JSON (8 bytes header + payload)
  glbBuffer.writeUInt32LE(jsonBuf.length, 12);
  glbBuffer.writeUInt32LE(0x4E4F534A, 16); // ChunkType: 'JSON'
  jsonBuf.copy(glbBuffer, 20);

  // 3. Chunk 1: BIN (8 bytes header + payload)
  const binOffset = 20 + jsonBuf.length;
  glbBuffer.writeUInt32LE(paddedBin.length, binOffset);
  glbBuffer.writeUInt32LE(0x004E4942, binOffset + 4); // ChunkType: 'BIN\0'
  paddedBin.copy(glbBuffer, binOffset + 8);

  return glbBuffer;
}
