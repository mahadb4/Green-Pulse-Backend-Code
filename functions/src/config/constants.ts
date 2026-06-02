import { ActionType, ActionConfig } from '../types';

export const ACTION_CONFIG: Record<ActionType, ActionConfig> = {
  recycle_bottle: { points: 10, nutrient: 5,  water: 0, health: 0,  cleanliness: 8,  threshold: 0.80 },
  plant_seed:     { points: 20, nutrient: 0,  water: 0, health: 10, cleanliness: 7,  threshold: 0.80 },
  water_plant:    { points: 6,  nutrient: 0,  water: 8, health: 0,  cleanliness: 4,  threshold: 0.80 },
  pick_litter:    { points: 15, nutrient: 0,  water: 0, health: 8,  cleanliness: 12, threshold: 0.80 },
  compost_waste:  { points: 18, nutrient: 10, water: 0, health: 0,  cleanliness: 9,  threshold: 0.85 },
  turn_off_light: { points: 5,  nutrient: 0,  water: 0, health: 3,  cleanliness: 5,  threshold: 0.90 },
};

export const GARDEN_STAGE_THRESHOLDS = {
  barren:   { min: 0,  max: 19  },
  seedling: { min: 20, max: 39  },
  sapling:  { min: 40, max: 59  },
  tree:     { min: 60, max: 79  },
  forest:   { min: 80, max: 100 },
};

// World cleanup stages — drives how dirty/clean the 3D world renders.
export const WORLD_STAGE_THRESHOLDS = {
  wasteland:  { min: 0,  max: 19  },   // choked with garbage & smog
  polluted:   { min: 20, max: 44  },   // still heavily littered
  recovering: { min: 45, max: 69  },   // visibly clearing up, greenery returning
  clean:      { min: 70, max: 99  },   // nearly pristine
  eco_city:   { min: 100, max: 100 },  // fully clean → city-building unlocked
};

export const CLEANLINESS_MAX = 100;
export const CLEANLINESS_DECAY_PER_DAY = 4;   // pollution slowly creeps back each day

// City-builder economy (energy points). Mirrored by BUILDING_CATALOG on the frontend.
export const BUILDING_COSTS: Record<string, number> = {
  house: 30,
  park: 20,
  solar: 50,
  windmill: 60,
};
export const BUILDING_REFUND_RATE = 0.5;      // refund half the cost when bulldozing

export const STREAK_MULTIPLIER = 1.5;
export const STREAK_THRESHOLD = 3;           // streak >= 3 activates multiplier
export const STREAK_WINDOW_HOURS = 24;       // must act within 24h to maintain streak

export const DECAY_PER_MEMBER = 1;           // garden_health reduced by this per member per day
export const WATER_CONSUME_PER_MEMBER = 2;   // water_level reduced per member per day
export const NUTRIENT_CONSUME_PER_MEMBER = 1;

export const WATERER_THRESHOLD = 20;         // water_level below this triggers Waterer agent
export const WATERER_MULTIPLIER = 1.5;       // bonus for water actions when Waterer is active
export const HEALTH_ALERT_THRESHOLD = 30;    // send push notification if health drops below this

export const PHOTO_DELETE_HOURS = 24;        // delete action photos after this many hours
export const CV_RESPONSE_TIMEOUT_MS = 12000; // per-model SLA; 2 models worst-case (~24s) stays under the app's 45s wait
export const ACTION_QUEUE_INTERVAL_MINUTES = 30; // Coordinator processes queue every 30 min

// ─── Anti-cheat: real-time / live-photo + duplicate detection ────────────────
// Below this authenticity score the photo looks like a screenshot, stock image,
// watermarked download or a photo-of-a-screen rather than a genuine live capture.
export const AUTHENTICITY_THRESHOLD = 0.6;
// Duplicate detection compares SHA-256 byte hashes for an EXACT match.
// Cap how many prior images we compare against per garden (cost / latency guard).
export const DUPLICATE_SCAN_LIMIT = 1500;
