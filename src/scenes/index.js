// Scene order = draw order. Each scene is active on [start, end); overlapping
// scenes all render (later ones on top).
import walk from './walk.js';

export const SCENES = [walk];
