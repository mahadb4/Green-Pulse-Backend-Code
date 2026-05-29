import * as admin from 'firebase-admin';

export type GardenStage = 'barren' | 'seedling' | 'sapling' | 'tree' | 'forest';

// World cleanup progression (drives the 3D world): 0 = polluted wasteland, 100 = pristine eco-city.
export type WorldStage = 'wasteland' | 'polluted' | 'recovering' | 'clean' | 'eco_city';

// Two game phases: clean the polluted world, then build a pollution-free city on it.
export type WorldPhase = 'cleanup' | 'building';

export interface Building {
  id: string;
  type: string;            // e.g. 'house', 'park', 'solar_plant', 'windmill'
  x: number;               // grid coordinates in the 3D world
  z: number;
  placed_at: admin.firestore.Timestamp;
}

export type ActionType =
  | 'recycle_bottle'
  | 'plant_seed'
  | 'water_plant'
  | 'pick_litter'
  | 'compost_waste'
  | 'turn_off_light';

export type ActionStatus = 'pending' | 'verifying' | 'verified' | 'approved' | 'rejected' | 'failed';

export interface GardenState {
  garden_health: number;        // 0–100  (legacy garden metric, kept for back-compat)
  garden_stage: GardenStage;
  water_level: number;          // 0–100
  nutrient_level: number;       // 0–100
  action_queue: string[];       // array of action IDs pending processing
  member_count: number;
  created_at: admin.firestore.Timestamp;

  // ─── World cleanup + city builder (new core mechanic) ───────────────────────
  cleanliness: number;          // 0–100, raised by verified eco-actions
  world_stage: WorldStage;      // derived from cleanliness
  phase: WorldPhase;            // 'cleanup' until cleanliness hits 100, then 'building'
  buildings: Building[];        // city placed in the building phase
}

export interface ChildState {
  energy_points: number;        // >= 0, written only by Reward agent
  current_streak: number;       // >= 0
  parent_approved: boolean;     // false until VPC Cloud Function sets true
  nickname: string | null;      // alphanumeric only
  garden_id: string;
  last_action_at: admin.firestore.Timestamp | null;
}

export interface ActionDocument {
  child_uid: string;
  garden_id: string;
  action_type: ActionType;
  status: ActionStatus;
  confidence: number;           // 0.0–1.0 from Gemini Vision
  detected_label: string;       // what CV agent detected
  photo_url: string;            // deleted from Storage within 24h
  created_at: admin.firestore.Timestamp;
  processed_at: admin.firestore.Timestamp | null;
}

export interface CVResult {
  verified: boolean;
  confidence: number;
  detected_label: string;
  reason: string;               // human-readable reason for reject
}

export interface ActionConfig {
  points: number;
  nutrient: number;
  water: number;
  health: number;
  cleanliness: number;          // how much this action cleans the world (0–100 scale)
  threshold: number;            // minimum confidence to verify
}
