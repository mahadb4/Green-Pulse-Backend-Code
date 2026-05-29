import * as admin from 'firebase-admin';

export type GardenStage = 'barren' | 'seedling' | 'sapling' | 'tree' | 'forest';

export type ActionType =
  | 'recycle_bottle'
  | 'plant_seed'
  | 'water_plant'
  | 'pick_litter'
  | 'compost_waste'
  | 'turn_off_light';

export type ActionStatus = 'pending' | 'verifying' | 'verified' | 'approved' | 'rejected' | 'failed';

export interface GardenState {
  garden_health: number;        // 0–100
  garden_stage: GardenStage;
  water_level: number;          // 0–100
  nutrient_level: number;       // 0–100
  action_queue: string[];       // array of action IDs pending processing
  member_count: number;
  created_at: admin.firestore.Timestamp;
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
  threshold: number;            // minimum confidence to verify
}
