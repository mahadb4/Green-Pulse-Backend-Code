import { ActionType, ActionConfig } from '../types';

export const ACTION_CONFIG: Record<ActionType, ActionConfig> = {
  recycle_bottle: { points: 10, nutrient: 5,  water: 0, health: 0,  threshold: 0.80 },
  plant_seed:     { points: 20, nutrient: 0,  water: 0, health: 10, threshold: 0.80 },
  water_plant:    { points: 6,  nutrient: 0,  water: 8, health: 0,  threshold: 0.80 },
  pick_litter:    { points: 15, nutrient: 0,  water: 0, health: 8,  threshold: 0.80 },
  compost_waste:  { points: 18, nutrient: 10, water: 0, health: 0,  threshold: 0.85 },
  turn_off_light: { points: 5,  nutrient: 0,  water: 0, health: 3,  threshold: 0.90 },
};

export const GARDEN_STAGE_THRESHOLDS = {
  barren:   { min: 0,  max: 19  },
  seedling: { min: 20, max: 39  },
  sapling:  { min: 40, max: 59  },
  tree:     { min: 60, max: 79  },
  forest:   { min: 80, max: 100 },
};

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
export const CV_RESPONSE_TIMEOUT_MS = 4000;  // 4 second SLA for CV agent
export const ACTION_QUEUE_INTERVAL_MINUTES = 30; // Coordinator processes queue every 30 min
