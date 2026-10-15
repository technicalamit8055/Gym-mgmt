/**
 * A front and a back figure with every muscle group drawn as its own shape, so
 * any mix of groups can be lit up at once — the body on Hevy's share cards.
 *
 * Plain SVG markup rather than DOM nodes: the share cards are one SVG string
 * that is shown inline and rasterised to a PNG, and this drops straight in.
 *
 * Both figures live in a 200 × 410 box. Paired muscles are drawn once, on the
 * figure's left (the viewer's left), and mirrored about x = 100.
 */

export const BODY_W = 200;
export const BODY_H = 410;

/** [group, path] — `null` group is skin that never lights up (head, hands,
 * knees, feet). Drawn on the left and mirrored. */
const FRONT_PAIRED = [
  ['traps', 'M89 55 L89 63 Q80 66 70 68 Q79 60 89 55 Z'],
  ['shoulders', 'M68 69 Q55 70 49 84 Q46 94 47 105 Q54 97 63 95 Q66 82 74 72 Z'],
  ['chest', 'M77 70 Q88 68 98 72 L98 100 Q88 106 76 104 Q68 101 65 96 Q67 80 77 70 Z'],
  ['biceps', 'M47 108 Q55 99 63 98 Q66 105 64 117 Q61 129 55 137 Q48 137 45 129 Q43 117 47 108 Z'],
  ['forearms', 'M43 139 Q51 137 58 141 Q61 150 58 161 Q54 173 48 185 L39 185 Q36 168 38 154 Q39 145 43 139 Z'],
  [null, 'M39 187 L47 187 Q50 196 47 206 Q43 210 39 206 Q35 196 39 187 Z'],
  ['abdominals', 'M66 105 Q72 108 79 109 L84 112 L84 160 Q78 167 72 167 Q68 151 68 135 Q66 119 66 105 Z'],
  ['abdominals', 'M86 105 L98 105 L98 119 L86 119 Z'],
  ['abdominals', 'M86 122 L98 122 L98 137 L86 137 Z'],
  ['abdominals', 'M86 140 L98 140 L98 155 L86 155 Z'],
  ['abdominals', 'M86 158 L98 158 L98 182 Q90 178 86 168 Z'],
  ['abductors', 'M67 160 Q72 166 71 173 Q66 186 64 204 Q61 186 63 172 Q64 165 67 160 Z'],
  ['quadriceps', 'M73 174 Q83 178 89 188 Q88 220 90 248 Q90 270 86 282 Q78 288 70 282 Q64 262 64 236 Q65 206 72 172 Z'],
  ['adductors', 'M93 193 Q99 199 99 212 Q98 232 93 252 Q91 236 91 214 Q91 201 93 193 Z'],
  [null, 'M70 288 Q78 292 87 288 Q89 296 86 301 Q78 304 70 301 Q68 295 70 288 Z'],
  ['calves', 'M69 305 Q78 301 87 306 Q89 324 86 346 Q83 366 80 380 L73 380 Q68 360 67 338 Q66 320 69 305 Z'],
  [null, 'M72 383 L81 383 Q86 391 88 398 Q80 403 70 401 Q70 391 72 383 Z'],
];

const FRONT_CENTER = [
  [null, 'M100 8 Q117 8 117 30 Q117 46 100 52 Q83 46 83 30 Q83 8 100 8 Z'],
  ['neck', 'M91 47 Q100 54 109 47 L111 62 Q100 67 89 62 Z'],
];

const BACK_PAIRED = [
  ['shoulders', 'M68 70 Q55 71 49 85 Q46 95 47 105 Q54 98 63 96 Q66 84 72 74 Z'],
  ['upper_back', 'M74 75 Q84 76 89 85 Q94 97 97 112 L86 111 Q76 104 66 97 Q68 84 74 75 Z'],
  ['triceps', 'M47 108 Q55 100 64 100 Q66 107 64 119 Q61 130 55 137 Q48 137 45 129 Q43 117 47 108 Z'],
  ['forearms', 'M43 139 Q51 137 58 141 Q61 150 58 161 Q54 173 48 185 L39 185 Q36 168 38 154 Q39 145 43 139 Z'],
  [null, 'M39 187 L47 187 Q50 196 47 206 Q43 210 39 206 Q35 196 39 187 Z'],
  ['lats', 'M66 100 Q76 106 86 114 L98 116 L98 138 Q92 142 84 146 Q77 152 72 160 Q68 142 68 126 Q66 112 66 100 Z'],
  ['abductors', 'M68 168 Q65 180 64 194 Q65 204 67 212 Q66 190 70 168 Z'],
  ['glutes', 'M72 168 Q86 170 99 180 L99 210 Q88 218 77 214 Q69 206 69 190 Q69 177 72 168 Z'],
  ['hamstrings', 'M70 217 Q82 223 96 219 Q96 244 92 268 Q90 280 86 286 Q78 290 70 284 Q66 264 66 242 Q66 227 70 217 Z'],
  [null, 'M70 289 Q78 293 87 289 Q89 296 87 300 Q78 303 70 300 Q68 295 70 289 Z'],
  ['calves', 'M68 303 Q78 297 89 304 Q91 320 88 338 Q84 358 81 378 L73 378 Q67 354 66 332 Q65 314 68 303 Z'],
  [null, 'M72 381 L82 381 Q85 390 85 397 Q78 401 71 399 Q70 390 72 381 Z'],
];

const BACK_CENTER = [
  [null, 'M100 8 Q117 8 117 30 Q117 46 100 52 Q83 46 83 30 Q83 8 100 8 Z'],
  ['traps', 'M100 50 Q94 56 86 60 Q77 64 70 68 Q82 72 90 82 Q96 96 100 116 Q104 96 110 82 Q118 72 130 68 Q123 64 114 60 Q106 56 100 50 Z'],
  ['lower_back', 'M87 146 Q94 141 100 140 Q106 141 113 146 L116 168 Q108 171 100 176 Q92 171 84 168 Z'],
];

/** Everything lights for a full-body move; cardio and "other" name no muscle. */
export function musclesWorked(groups) {
  const lit = new Set(groups);
  if (lit.has('full_body')) {
    for (const [group] of [...FRONT_PAIRED, ...BACK_PAIRED, ...FRONT_CENTER, ...BACK_CENTER]) if (group) lit.add(group);
  }
  return lit;
}

/**
 * One figure as an SVG <g>, its top-left at (x, y) and `height` tall.
 *
 *   side    'front' | 'back'
 *   lit     a Set of muscle groups to colour (see musclesWorked)
 *   colors  { skin, muscle, accent, line }
 */
export function bodyFigure(side, lit, { x = 0, y = 0, height = BODY_H, colors }) {
  const scale = height / BODY_H;
  const [paired, center] = side === 'back' ? [BACK_PAIRED, BACK_CENTER] : [FRONT_PAIRED, FRONT_CENTER];
  const shape = ([group, d]) => {
    const fill = !group ? colors.skin : lit.has(group) ? colors.accent : colors.muscle;
    return `<path d="${d}" fill="${fill}"/>`;
  };
  const left = paired.map(shape).join('');
  return (
    `<g transform="translate(${x} ${y}) scale(${scale})" stroke="${colors.line}" stroke-width="1.6" stroke-linejoin="round">` +
    `${left}<g transform="translate(${BODY_W} 0) scale(-1 1)">${left}</g>${center.map(shape).join('')}</g>`
  );
}
