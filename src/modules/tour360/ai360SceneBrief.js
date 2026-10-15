// Deterministic scene briefs for a five-room apartment. No AI API calls or storage writes.
// A future image provider must return an actual 2:1 equirectangular panorama;
// ordinary perspective images are NOT valid 360° panoramas.
export const PILOT_LAYOUT = Object.freeze({
  projectId: 3,
  layoutTypeId: 7,
  layoutCode: 'PDF20251016-A-6',
  planImageUrl: 'https://res.cloudinary.com/r3pnvm9s/image/upload/v1791924599/tozon-crm/meoyexraft1mehzl7m0p.png',
  technicalPlanUrl: 'https://res.cloudinary.com/r3pnvm9s/image/upload/v1791924592/tozon-crm/mbdavwdrp920og9rwpzc.png',
  // Database area_m2_x100 = 8120 (81.20m²); display name says 81.18m².
  // Do not assume either area is authoritative until reconciled.
});

const ROOM_BRIEFS = Object.freeze({
  'Гостиная': 'Modern comfortable living room, sofa, coffee table, media wall, warm layered lighting, restrained neutral palette.',
  'Спальня': 'Modern comfortable bedroom, double bed, side tables, built-in wardrobe, soft textiles, warm indirect lighting.',
  'Кухня': 'Modern comfortable kitchen, practical cabinetry, integrated appliances, dining space, durable worktop, soft daylight.',
  'Санузел': 'Modern comfortable bathroom, shower, vanity, mirror, ceramic finishes, practical storage, soft diffused lighting.',
  'Коридор': 'Modern comfortable entrance corridor, built-in storage, mirror, functional lighting, clear paths to other rooms.'
});

export const REQUIRED_360_ROOMS = Object.freeze(Object.keys(ROOM_BRIEFS));

export function buildAi360SceneBrief(room, { layoutCode = PILOT_LAYOUT.layoutCode } = {}) {
  if (!Object.hasOwn(ROOM_BRIEFS, room)) throw new Error('Unsupported 360 room');
  if (typeof layoutCode !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(layoutCode)) throw new Error('Invalid layout code');
  return Object.freeze({
    room,
    layoutCode,
    aspectRatio: '2:1',
    projection: 'equirectangular',
    targetWidth: 4096,
    targetHeight: 2048,
    prompt: [
      'Photorealistic architectural visualization of ONE room in an apartment.',
      ROOM_BRIEFS[room],
      'Use the supplied furnished and technical floor plans as binding references for walls, windows, doors, room dimensions and circulation.',
      'Do not invent additional windows, doors, balconies or rooms. Keep consistent finishes across all five scenes.',
      'Camera at 1.55m above floor, fixed central position inside this room.',
      'TRUE seamless full-sphere 360x180 equirectangular panorama, 2:1 image, continuous left-right seam, correct zenith and nadir.',
      'No text, labels, logos, people, watermarks, split screens, perspective-only renders or collage.',
      'If the plan is ambiguous, preserve the uncertainty rather than fabricating architectural details.'
    ].join(' '),
    negativePrompt: 'fisheye circle, cubemap faces, flat perspective, distorted walls, extra doors, extra windows, text, watermark, people',
    references: [PILOT_LAYOUT.planImageUrl, PILOT_LAYOUT.technicalPlanUrl]
  });
}

export function buildPilotAi360Manifest() {
  return Object.freeze({
    ...PILOT_LAYOUT,
    scenes: REQUIRED_360_ROOMS.map(room => buildAi360SceneBrief(room)),
    status: 'PROMPT_ONLY',
    requiresProvider: true,
    requiresHumanGeometryReview: true,
    publicationAllowed: false
  });
}
