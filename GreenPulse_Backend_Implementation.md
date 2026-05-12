# GreenPulse — Backend & AI Agents Implementation Guide

> **For:** Claude Code  
> **Project:** GreenPulse — The Collaborative Carbon Garden  
> **Stack:** Firebase Cloud Functions (TypeScript) + Google Genkit + Gemini Vision  
> **Developer Role:** M1 — AI & Backend Lead

---

## 1. Project Context

GreenPulse is a mobile app where children photograph real-world eco-actions (recycling, planting, etc.). A multi-agent AI system verifies these photos using Gemini Vision and updates a shared virtual garden. This document covers **only the backend** — Firebase Cloud Functions, AI agents, and Firestore schema. The Flutter frontend is handled by a separate team member.

---

## 2. Prerequisites & Initial Setup

### 2.1 Required Tools
```bash
node --version    # Must be v18 or higher
npm --version
firebase --version  # If missing: npm install -g firebase-tools
```

### 2.2 Firebase Project
- Project ID: `greenpulse-dev`
- Enable these Firebase services in the console:
  - Firestore Database (Native mode)
  - Firebase Storage
  - Cloud Functions
  - Firebase Auth (Anonymous sign-in enabled)
  - Cloud Messaging (FCM)

### 2.3 Repository Structure
Work inside the `functions/` directory. Branch: `feat/ai-backend`

```
functions/
├── src/
│   ├── index.ts                  ← exports all Cloud Functions
│   ├── agents/
│   │   ├── coordinator.ts        ← Coordinator agent (main brain)
│   │   ├── cvAgent.ts            ← Gemini Vision verification
│   │   ├── rewardAgent.ts        ← energy points + streak logic
│   │   ├── watererAgent.ts       ← water level management
│   │   └── decayAgent.ts         ← 24h cron health decay
│   ├── tools/
│   │   └── schemas.ts            ← Genkit tool schemas
│   ├── config/
│   │   └── constants.ts          ← thresholds, point values, decay rates
│   └── types/
│       └── index.ts              ← TypeScript interfaces
├── .env                          ← secrets (never commit)
├── .gitignore
└── package.json
```

---

## 3. Package Installation

```bash
cd functions

# Core Firebase
npm install firebase-admin firebase-functions

# Genkit + Google AI
npm install @genkit-ai/firebase @genkit-ai/google-ai @genkit-ai/core genkit

# HTTP client
npm install axios

# Dev dependencies
npm install --save-dev typescript @types/node
```

---

## 4. Environment Variables

Create `functions/.env`:
```
GEMINI_API_KEY=your_gemini_api_key_here
```

Create/update `functions/.gitignore`:
```
.env
lib/
node_modules/
```

Get the Gemini API key from: https://aistudio.google.com

---

## 5. TypeScript Types — `src/types/index.ts`

```typescript
import * as admin from 'firebase-admin';

export type GardenStage = 'barren' | 'seedling' | 'sapling' | 'tree' | 'forest';

export type ActionType =
  | 'recycle_bottle'
  | 'plant_seed'
  | 'water_plant'
  | 'pick_litter'
  | 'compost_waste'
  | 'turn_off_light';

export type ActionStatus = 'pending' | 'verified' | 'rejected';

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
```

---

## 6. Constants — `src/config/constants.ts`

```typescript
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
```

---

## 7. Genkit Tool Schemas — `src/tools/schemas.ts`

```typescript
import { z } from 'genkit';

// Tool: verify an eco-action photo using Gemini Vision
export const verifyActionInputSchema = z.object({
  photo_url: z.string().describe('Firebase Storage URL of the action photo'),
  action_type: z.string().describe('Type of eco-action claimed by child'),
  action_description: z.string().describe('Human-readable description of what to look for'),
});

export const verifyActionOutputSchema = z.object({
  verified: z.boolean().describe('Whether the action is confirmed present in the image'),
  confidence: z.number().min(0).max(1).describe('Model confidence score 0.0–1.0'),
  detected_label: z.string().describe('What the model actually detected in the image'),
  reason: z.string().describe('Explanation of the decision, especially for rejections'),
});

// Tool: update garden resources after a verified action
export const updateGardenInputSchema = z.object({
  garden_id: z.string(),
  health_delta: z.number(),
  water_delta: z.number(),
  nutrient_delta: z.number(),
});

// Tool: award energy points to a child
export const rewardChildInputSchema = z.object({
  child_uid: z.string(),
  base_points: z.number(),
  streak_multiplier: z.number().default(1.0),
  action_type: z.string(),
});
```

---

## 8. CV Agent — `src/agents/cvAgent.ts`

```typescript
import * as admin from 'firebase-admin';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ActionType, CVResult } from '../types';
import { ACTION_CONFIG, CV_RESPONSE_TIMEOUT_MS } from '../config/constants';

const CV_PROMPTS: Record<ActionType, string> = {
  recycle_bottle:  'Look for a plastic bottle being placed into or near a recycling bin. Both the bottle AND recycling bin must be clearly visible. Return JSON only.',
  plant_seed:      'Look for a freshly planted seed or small sapling in soil. Soil disturbance or a small plant emerging from ground must be visible. Return JSON only.',
  water_plant:     'Look for a watering can, bottle, or hose actively watering a visible plant. Both the water source and plant must be present. Return JSON only.',
  pick_litter:     'This is a before/after pair. In the before image, litter should be visible. In the after, the same scene should be cleaner. Assess the pair together. Return JSON only.',
  compost_waste:   'Look for food scraps, organic waste, or vegetable matter being placed into a compost bin or compost pile. Return JSON only.',
  turn_off_light:  'Look for a light switch in the OFF position in a clearly unlit room. The room must appear dark/unlit. High false-positive risk — be strict. Return JSON only.',
};

export async function verifyAction(
  photoUrl: string,
  actionType: ActionType
): Promise<CVResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const config = ACTION_CONFIG[actionType];
  const prompt = CV_PROMPTS[actionType];

  // Download image from Firebase Storage
  const bucket = admin.storage().bucket();
  const filePath = decodeURIComponent(photoUrl.split('/o/')[1].split('?')[0]);
  const [imageBuffer] = await bucket.file(filePath).download();
  const base64Image = imageBuffer.toString('base64');

  const genai = new GoogleGenerativeAI(apiKey);
  const model = genai.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const systemPrompt = `
You are a CV verification agent for a children's eco-action app.
Your job: determine if the submitted photo shows the claimed eco-action.
Context: Karachi, Pakistan. Images may show Urdu labels, indoor/outdoor settings, varied lighting.

${prompt}

Respond ONLY with this exact JSON structure, no markdown, no extra text:
{
  "verified": boolean,
  "confidence": number between 0.0 and 1.0,
  "detected_label": "what you actually see in the image",
  "reason": "brief explanation of your decision"
}
`;

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('CV agent timeout')), CV_RESPONSE_TIMEOUT_MS)
  );

  const cvPromise = model.generateContent([
    systemPrompt,
    { inlineData: { data: base64Image, mimeType: 'image/jpeg' } },
  ]);

  const result = await Promise.race([cvPromise, timeoutPromise]);
  const text = result.response.text().trim();

  let parsed: CVResult;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`CV agent returned invalid JSON: ${text}`);
  }

  // Apply confidence threshold
  if (parsed.confidence < config.threshold) {
    parsed.verified = false;
    parsed.reason = `Confidence ${parsed.confidence} below threshold ${config.threshold}`;
  }

  return parsed;
}
```

---

## 9. Reward Agent — `src/agents/rewardAgent.ts`

```typescript
import * as admin from 'firebase-admin';
import { ChildState, ActionType } from '../types';
import { ACTION_CONFIG, STREAK_THRESHOLD, STREAK_MULTIPLIER, STREAK_WINDOW_HOURS } from '../config/constants';

export async function runRewardAgent(
  childUid: string,
  actionType: ActionType,
  gardenId: string
): Promise<{ pointsAwarded: number; newStreak: number }> {
  const db = admin.firestore();
  const childRef = db.collection('children').doc(childUid);

  return db.runTransaction(async (tx) => {
    const childSnap = await tx.get(childRef);
    if (!childSnap.exists) throw new Error(`Child ${childUid} not found`);

    const child = childSnap.data() as ChildState;
    const config = ACTION_CONFIG[actionType];
    const now = admin.firestore.Timestamp.now();

    // Calculate streak
    let newStreak = 1;
    if (child.last_action_at) {
      const hoursSinceLastAction =
        (now.toMillis() - child.last_action_at.toMillis()) / (1000 * 60 * 60);
      if (hoursSinceLastAction <= STREAK_WINDOW_HOURS) {
        newStreak = child.current_streak + 1;
      }
    }

    // Apply streak multiplier
    const multiplier = newStreak >= STREAK_THRESHOLD ? STREAK_MULTIPLIER : 1.0;
    const pointsAwarded = Math.round(config.points * multiplier);

    tx.update(childRef, {
      energy_points: admin.firestore.FieldValue.increment(pointsAwarded),
      current_streak: newStreak,
      last_action_at: now,
    });

    // Log reward event for parent dashboard
    const rewardLogRef = db.collection('reward_log').doc();
    tx.set(rewardLogRef, {
      child_uid: childUid,
      garden_id: gardenId,
      action_type: actionType,
      points_awarded: pointsAwarded,
      streak: newStreak,
      multiplier_applied: multiplier > 1.0,
      created_at: now,
    });

    return { pointsAwarded, newStreak };
  });
}
```

---

## 10. Waterer Agent — `src/agents/watererAgent.ts`

```typescript
import * as admin from 'firebase-admin';
import { WATERER_THRESHOLD } from '../config/constants';

/**
 * Checks if Waterer agent should be active for a garden.
 * Returns the water multiplier (1.5x if water is low, 1.0 otherwise).
 */
export async function getWatererMultiplier(gardenId: string): Promise<number> {
  const gardenSnap = await admin.firestore()
    .collection('gardens')
    .doc(gardenId)
    .get();

  if (!gardenSnap.exists) return 1.0;

  const { water_level } = gardenSnap.data()!;
  return water_level < WATERER_THRESHOLD ? 1.5 : 1.0;
}

/**
 * Sends a "thirsty" notification to all members of a garden.
 * Called by Coordinator when water_level < WATERER_THRESHOLD.
 */
export async function sendThirstyNotification(gardenId: string): Promise<void> {
  const messaging = admin.messaging();

  // Get all children in this garden
  const children = await admin.firestore()
    .collection('children')
    .where('garden_id', '==', gardenId)
    .get();

  const tokens: string[] = [];
  children.forEach(doc => {
    const { fcm_token } = doc.data();
    if (fcm_token) tokens.push(fcm_token);
  });

  if (tokens.length === 0) return;

  await messaging.sendEachForMulticast({
    tokens,
    notification: {
      title: '🌵 Zara is thirsty!',
      body: 'Your garden needs water. Try a water-saving action today!',
    },
    data: {
      type: 'zara_state',
      zara_state: 'thirsty',
      garden_id: gardenId,
    },
  });
}
```

---

## 11. Decay Agent — `src/agents/decayAgent.ts`

```typescript
import * as admin from 'firebase-admin';
import {
  DECAY_PER_MEMBER,
  WATER_CONSUME_PER_MEMBER,
  NUTRIENT_CONSUME_PER_MEMBER,
  HEALTH_ALERT_THRESHOLD,
} from '../config/constants';
import { GardenState, GardenStage } from '../types';
import { GARDEN_STAGE_THRESHOLDS } from '../config/constants';

function calculateStage(health: number): GardenStage {
  for (const [stage, range] of Object.entries(GARDEN_STAGE_THRESHOLDS)) {
    if (health >= range.min && health <= range.max) {
      return stage as GardenStage;
    }
  }
  return 'barren';
}

export async function runDecayAgent(): Promise<void> {
  const db = admin.firestore();
  const messaging = admin.messaging();
  const gardens = await db.collection('gardens').get();
  const batch = db.batch();
  const alertGardens: { gardenId: string; health: number }[] = [];

  gardens.forEach(doc => {
    const garden = doc.data() as GardenState;
    const { member_count, garden_health, water_level, nutrient_level } = garden;

    const newHealth = Math.max(0, garden_health - (DECAY_PER_MEMBER * member_count));
    const newWater = Math.max(0, water_level - (WATER_CONSUME_PER_MEMBER * member_count));
    const newNutrient = Math.max(0, nutrient_level - (NUTRIENT_CONSUME_PER_MEMBER * member_count));
    const newStage = calculateStage(newHealth);

    batch.update(doc.ref, {
      garden_health: newHealth,
      water_level: newWater,
      nutrient_level: newNutrient,
      garden_stage: newStage,
    });

    if (newHealth < HEALTH_ALERT_THRESHOLD) {
      alertGardens.push({ gardenId: doc.id, health: newHealth });
    }
  });

  await batch.commit();

  // Send push notifications for gardens in critical health
  for (const { gardenId } of alertGardens) {
    const children = await db.collection('children')
      .where('garden_id', '==', gardenId)
      .get();

    const tokens: string[] = [];
    children.forEach(doc => {
      const { fcm_token } = doc.data();
      if (fcm_token) tokens.push(fcm_token);
    });

    if (tokens.length === 0) continue;

    await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: '🌧️ Zara is sad!',
        body: 'Your garden needs help! Take an eco-action to save it.',
      },
      data: {
        type: 'zara_state',
        zara_state: 'sad',
        garden_id: gardenId,
      },
    });
  }
}
```

---

## 12. Coordinator Agent — `src/agents/coordinator.ts`

This is the brain. It receives an action, calls the CV agent, then dispatches to Reward, Waterer, and garden update logic.

```typescript
import * as admin from 'firebase-admin';
import { verifyAction } from './cvAgent';
import { runRewardAgent } from './rewardAgent';
import { getWatererMultiplier, sendThirstyNotification } from './watererAgent';
import { ActionDocument, ActionType, GardenState } from '../types';
import { ACTION_CONFIG, WATERER_THRESHOLD, GARDEN_STAGE_THRESHOLDS } from '../config/constants';
import { GardenStage } from '../types';

function calculateStage(health: number): GardenStage {
  for (const [stage, range] of Object.entries(GARDEN_STAGE_THRESHOLDS)) {
    if (health >= range.min && health <= range.max) {
      return stage as GardenStage;
    }
  }
  return 'barren';
}

export async function runCoordinator(
  actionId: string,
  action: ActionDocument
): Promise<void> {
  const db = admin.firestore();
  const actionRef = db.collection('actions').doc(actionId);

  try {
    // Step 1: Route to CV Agent
    const cvResult = await verifyAction(action.photo_url, action.action_type as ActionType);

    // Step 2: Update action document with CV result
    await actionRef.update({
      status: cvResult.verified ? 'verified' : 'rejected',
      confidence: cvResult.confidence,
      detected_label: cvResult.detected_label,
      processed_at: admin.firestore.Timestamp.now(),
    });

    if (!cvResult.verified) {
      console.log(`Action ${actionId} rejected: ${cvResult.reason}`);
      return;
    }

    // Step 3: Verified — update garden resources
    const config = ACTION_CONFIG[action.action_type as ActionType];
    const gardenRef = db.collection('gardens').doc(action.garden_id);

    // Check if Waterer agent should boost water actions
    const watererMultiplier = await getWatererMultiplier(action.garden_id);
    const waterBoost = action.action_type === 'water_plant' ? watererMultiplier : 1.0;

    await db.runTransaction(async (tx) => {
      const gardenSnap = await tx.get(gardenRef);
      if (!gardenSnap.exists) throw new Error(`Garden ${action.garden_id} not found`);

      const garden = gardenSnap.data() as GardenState;

      const newHealth = Math.min(100, garden.garden_health + config.health);
      const newWater = Math.min(100, garden.water_level + (config.water * waterBoost));
      const newNutrient = Math.min(100, garden.nutrient_level + config.nutrient);
      const newStage = calculateStage(newHealth);

      tx.update(gardenRef, {
        garden_health: newHealth,
        water_level: newWater,
        nutrient_level: newNutrient,
        garden_stage: newStage,
        action_queue: admin.firestore.FieldValue.arrayRemove(actionId),
      });
    });

    // Step 4: Dispatch Reward Agent
    const { pointsAwarded, newStreak } = await runRewardAgent(
      action.child_uid,
      action.action_type as ActionType,
      action.garden_id
    );

    console.log(`Coordinator: Action ${actionId} verified. +${pointsAwarded} pts, streak: ${newStreak}`);

    // Step 5: Check if Waterer notification needed
    const gardenSnap = await gardenRef.get();
    const garden = gardenSnap.data() as GardenState;
    if (garden.water_level < WATERER_THRESHOLD) {
      await sendThirstyNotification(action.garden_id);
    }

    // Step 6: Delete photo from Storage (COPPA compliance)
    try {
      const bucket = admin.storage().bucket();
      const filePath = decodeURIComponent(action.photo_url.split('/o/')[1].split('?')[0]);
      await bucket.file(filePath).delete();
    } catch (err) {
      console.error('Photo deletion failed (non-fatal):', err);
    }

  } catch (error) {
    console.error(`Coordinator error for action ${actionId}:`, error);
    await actionRef.update({ status: 'rejected', processed_at: admin.firestore.Timestamp.now() });
    throw error;
  }
}
```

---

## 13. Main Entry Point — `src/index.ts`

```typescript
import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { runCoordinator } from './agents/coordinator';
import { runDecayAgent } from './agents/decayAgent';
import { ActionDocument } from './types';

admin.initializeApp();

// ─────────────────────────────────────────────
// CALLABLE FUNCTION: Submit an eco-action
// Called by Flutter frontend after photo upload
// ─────────────────────────────────────────────
export const submitAction = functions.https.onCall(async (data, context) => {
  // Auth check
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  }

  const { action_type, photo_url, garden_id } = data;

  if (!action_type || !photo_url || !garden_id) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing required fields.');
  }

  // Check parent approval (COPPA gate)
  const childDoc = await admin.firestore()
    .collection('children')
    .doc(context.auth.uid)
    .get();

  if (!childDoc.exists || !childDoc.data()?.parent_approved) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Parent approval required before submitting actions.'
    );
  }

  // Create action document
  const actionRef = admin.firestore().collection('actions').doc();
  const actionData: ActionDocument = {
    child_uid: context.auth.uid,
    garden_id,
    action_type,
    status: 'pending',
    confidence: 0,
    detected_label: '',
    photo_url,
    created_at: admin.firestore.Timestamp.now(),
    processed_at: null,
  };

  await actionRef.set(actionData);

  // Add to garden queue
  await admin.firestore().collection('gardens').doc(garden_id).update({
    action_queue: admin.firestore.FieldValue.arrayUnion(actionRef.id),
  });

  // Run coordinator asynchronously (don't await — return immediately to client)
  runCoordinator(actionRef.id, actionData).catch(err =>
    console.error('Coordinator async error:', err)
  );

  return { success: true, action_id: actionRef.id, message: 'Action submitted for verification.' };
});

// ─────────────────────────────────────────────
// FIRESTORE TRIGGER: Process action on creation
// Backup trigger in case callable fails
// ─────────────────────────────────────────────
export const onActionCreated = functions.firestore
  .document('actions/{actionId}')
  .onCreate(async (snap, context) => {
    const action = snap.data() as ActionDocument;
    if (action.status !== 'pending') return; // Already processed
    await runCoordinator(context.params.actionId, action);
  });

// ─────────────────────────────────────────────
// SCHEDULED: Decay Agent — runs every 24 hours
// ─────────────────────────────────────────────
export const decayAgentScheduled = functions.pubsub
  .schedule('every 24 hours')
  .timeZone('Asia/Karachi')
  .onRun(async () => {
    await runDecayAgent();
  });

// ─────────────────────────────────────────────
// CALLABLE: Delete all user data (COPPA)
// Called by parent dashboard
// ─────────────────────────────────────────────
export const deleteAllData = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  }

  const uid = context.auth.uid;
  const db = admin.firestore();
  const bucket = admin.storage().bucket();

  // Delete Firestore documents
  await db.collection('children').doc(uid).delete();

  // Delete actions
  const actions = await db.collection('actions').where('child_uid', '==', uid).get();
  const batch = db.batch();
  actions.forEach(doc => batch.delete(doc.ref));
  await batch.commit();

  // Delete Storage files
  try {
    await bucket.deleteFiles({ prefix: `action-photos/${uid}/` });
  } catch (err) {
    console.error('Storage cleanup error (non-fatal):', err);
  }

  // Delete Auth account
  await admin.auth().deleteUser(uid);

  return { success: true, message: 'All data deleted.' };
});

// ─────────────────────────────────────────────
// CALLABLE: Get garden state (for frontend)
// ─────────────────────────────────────────────
export const getGardenState = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  }

  const { garden_id } = data;
  const gardenSnap = await admin.firestore().collection('gardens').doc(garden_id).get();

  if (!gardenSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Garden not found.');
  }

  return gardenSnap.data();
});
```

---

## 14. Firestore Security Rules

Paste into **Firebase Console → Firestore → Rules**:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Children can only read/write their own profile
    match /children/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }

    // Gardens: any authenticated user can read, only Cloud Functions write
    match /gardens/{gardenId} {
      allow read: if request.auth != null;
      allow write: if false;
    }

    // Actions: child can create own actions, read own actions only
    match /actions/{actionId} {
      allow create: if request.auth != null
                    && request.resource.data.child_uid == request.auth.uid
                    && request.resource.data.status == 'pending';
      allow read: if request.auth != null
                  && resource.data.child_uid == request.auth.uid;
      allow update, delete: if false;
    }

    // Reward log: child can read their own entries
    match /reward_log/{logId} {
      allow read: if request.auth != null
                  && resource.data.child_uid == request.auth.uid;
      allow write: if false;
    }
  }
}
```

---

## 15. Firebase Storage Rules

Paste into **Firebase Console → Storage → Rules**:

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /action-photos/{uid}/{photoId} {
      allow write: if request.auth != null
                   && request.auth.uid == uid
                   && request.resource.size < 5 * 1024 * 1024
                   && request.resource.contentType.matches('image/.*');
      allow read: if request.auth.uid == uid;
    }
  }
}
```

---

## 16. Firestore Initial Data Structure

Seed this manually in Firebase Console or via a one-time script:

### `/gardens/{gardenId}`
```json
{
  "garden_health": 30,
  "garden_stage": "seedling",
  "water_level": 50,
  "nutrient_level": 50,
  "action_queue": [],
  "member_count": 0,
  "created_at": "<timestamp>"
}
```

### `/children/{uid}`
```json
{
  "energy_points": 0,
  "current_streak": 0,
  "parent_approved": false,
  "nickname": null,
  "garden_id": "",
  "last_action_at": null,
  "fcm_token": null
}
```

---

## 17. Frontend Contract (Share with M2 — Flutter Dev)

### Callable Functions

| Function Name | Parameters | Returns | Notes |
|---|---|---|---|
| `submitAction` | `{ action_type, photo_url, garden_id }` | `{ success, action_id, message }` | Requires `parent_approved: true` |
| `deleteAllData` | none | `{ success, message }` | COPPA — deletes everything |
| `getGardenState` | `{ garden_id }` | Garden state object | Can also use Firestore listener |

### Firestore Real-Time Listeners (M2 should use these, not polling)

| Path | What it contains | When to listen |
|---|---|---|
| `/gardens/{gardenId}` | `garden_health`, `garden_stage`, `water_level`, `nutrient_level` | Garden screen |
| `/children/{uid}` | `energy_points`, `current_streak`, `parent_approved` | Profile screen, camera gate |
| `/actions/{actionId}` | `status`, `confidence`, `detected_label` | After submitAction to show Zara reaction |

### Zara State Mapping (triggered by FCM notifications)

| FCM `data.zara_state` | Trigger Condition | Zara Animation |
|---|---|---|
| `happy` | CV `verified: true` | Jumps, sparkles |
| `sad` | `garden_health < 30` | Droops, rain cloud |
| `thirsty` | `water_level < 20` | Tongue out, dry texture |
| `celebrating` | `garden_stage == 'forest'` | Crown, Ajrak coat glows |

---

## 18. Deployment

```bash
# Deploy only functions
firebase deploy --only functions

# Deploy with rules
firebase deploy --only functions,firestore:rules,storage:rules

# View logs
firebase functions:log

# Test locally
firebase emulators:start --only functions,firestore,storage
```

---

## 19. Testing Checklist

### CV Agent Tests (W7 — 20 adversarial images required)
- [ ] Valid recycle action — should verify
- [ ] Bottle without recycling bin — should reject
- [ ] Dark/blurry image — should reject (low confidence)
- [ ] Wrong action type submitted — should reject
- [ ] Urdu-labelled compost container — should verify
- [ ] Indoor vs outdoor water plant — both should verify
- [ ] Turn off light with lamp still on — should reject
- [ ] Pick litter — before/after pair, same scene — should verify

### Decay Agent Tests
- [ ] Garden health decrements by `member_count * 1` per run
- [ ] Garden never goes below 0
- [ ] Stage updates correctly at each threshold
- [ ] FCM notification sent when health < 30

### Reward Agent Tests
- [ ] Points awarded correctly per action type
- [ ] Streak increments within 24h
- [ ] Streak resets after 24h gap
- [ ] 1.5x multiplier applied at streak >= 3

---

## 20. Week-by-Week Commit Plan

| Week | Branch | What to commit |
|---|---|---|
| W3 | `feat/ai-backend` | `types/index.ts`, `constants.ts`, `schemas.ts` |
| W4 | `feat/ai-backend` | `cvAgent.ts` tested, `coordinator.ts` basic routing, `index.ts` callable stub |
| W5 | `feat/ai-backend` | All agents complete, end-to-end tested with real photos, `v0.1.0` tag |
| W6 | `feat/ai-backend` | Error handling hardened, `deleteAllData` complete, `v0.5.0` tag |
| W7 | `feat/ai-backend` | Adversarial test results in `/docs/cv-test-results.md`, `v1.0.0-rc` tag |
| W8 | `main` | Merge via PR, `v1.0.0` release tag |

---

## Notes for Claude Code

- All secrets go in `functions/.env` — never hardcoded
- All Firestore writes from agents use transactions where possible to prevent race conditions
- Photo URLs are Firebase Storage download URLs — the CV agent downloads them server-side
- The `deleteAllData` function is COPPA-critical — test it thoroughly
- The `onActionCreated` Firestore trigger and `submitAction` callable are intentionally redundant — the trigger is a safety net
- Run `firebase emulators:start` for local development before deploying
