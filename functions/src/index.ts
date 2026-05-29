import * as admin from 'firebase-admin';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { runCoordinator } from './agents/coordinator';
import { runDecayAgent } from './agents/decayAgent';
import { ActionDocument, Building } from './types';
import { BUILDING_COSTS, BUILDING_REFUND_RATE } from './config/constants';

// Initialize Firebase Admin SDK (only once)
if (!admin.apps.length) {
  admin.initializeApp();
}

// ─────────────────────────────────────────────────────────────────────────────
// CALLABLE v2: Submit an eco-action
// Called by the React Native app after photo upload.
// v2 uses `request.auth` (not `context.auth`) — compatible with Firebase JS SDK v9+
// ─────────────────────────────────────────────────────────────────────────────
export const submitAction = onCall(
  { region: 'us-central1', timeoutSeconds: 60 },
  async (request) => {
    // Auth check (v2 uses request.auth)
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const { action_type, photo_url, garden_id } = request.data as {
      action_type: string;
      photo_url: string;
      garden_id: string;
    };

    if (!action_type || !photo_url || !garden_id) {
      throw new HttpsError('invalid-argument', 'Missing required fields: action_type, photo_url, garden_id.');
    }

    const uid = request.auth.uid;

    // Check parent approval (COPPA gate)
    const childDoc = await admin.firestore()
      .collection('children')
      .doc(uid)
      .get();

    if (!childDoc.exists) {
      throw new HttpsError(
        'not-found',
        'Child profile not found. Please complete onboarding first.'
      );
    }

    if (!childDoc.data()?.parent_approved) {
      throw new HttpsError(
        'permission-denied',
        'Parent approval required before submitting actions.'
      );
    }

    // Create action document in Firestore
    const actionRef = admin.firestore().collection('actions').doc();
    const actionData: ActionDocument = {
      child_uid: uid,
      garden_id,
      action_type: action_type as any,
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

    // Run coordinator asynchronously — do NOT await so the callable returns immediately
    runCoordinator(actionRef.id, actionData).catch(err =>
      console.error('[submitAction] Coordinator async error:', err)
    );

    console.log(`[submitAction] ✅ Action ${actionRef.id} created for user ${uid}`);
    return { success: true, action_id: actionRef.id, message: 'Action submitted for verification.' };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// FIRESTORE TRIGGER v2: Process action on creation (backup path)
// Runs if the callable already called coordinator, but coordinator's transactional
// lock prevents double-processing.
// ─────────────────────────────────────────────────────────────────────────────
export const onActionCreated = onDocumentCreated(
  { document: 'actions/{actionId}', region: 'asia-southeast1' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const action = snap.data() as ActionDocument;
    const actionId = event.params.actionId;

    if (action.status !== 'pending') {
      console.log(`[onActionCreated] Action ${actionId} already processing (status: ${action.status}). Skipping.`);
      return;
    }

    await runCoordinator(actionId, action);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED v2: Decay Agent — runs every 24 hours
// ─────────────────────────────────────────────────────────────────────────────
export const decayAgentScheduled = onSchedule(
  { schedule: 'every 24 hours', timeZone: 'Asia/Karachi', region: 'us-central1' },
  async () => {
    console.log('[decayAgentScheduled] Running decay agent...');
    await runDecayAgent();
    console.log('[decayAgentScheduled] Done.');
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// CALLABLE v2: Delete all user data (COPPA right to erasure)
// ─────────────────────────────────────────────────────────────────────────────
export const deleteAllData = onCall(
  { region: 'us-central1', timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const uid = request.auth.uid;
    const db = admin.firestore();
    const bucket = admin.storage().bucket();

    // Delete Firestore child document
    await db.collection('children').doc(uid).delete();

    // Delete all action documents for this user
    const actions = await db.collection('actions').where('child_uid', '==', uid).get();
    const batch = db.batch();
    actions.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    // Delete reward log entries
    const rewards = await db.collection('reward_log').where('child_uid', '==', uid).get();
    const rewardBatch = db.batch();
    rewards.forEach(doc => rewardBatch.delete(doc.ref));
    await rewardBatch.commit();

    // Delete Storage files
    try {
      await bucket.deleteFiles({ prefix: `action-photos/${uid}/` });
    } catch (err) {
      console.error('[deleteAllData] Storage cleanup error (non-fatal):', err);
    }

    // Delete Auth account last
    await admin.auth().deleteUser(uid);

    console.log(`[deleteAllData] ✅ All data deleted for user ${uid}`);
    return { success: true, message: 'All data deleted.' };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// CALLABLE v2: Place a building in the eco-city (authoritative — spends energy points)
// ─────────────────────────────────────────────────────────────────────────────
export const placeBuilding = onCall(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in.');
    const uid = request.auth.uid;
    const { garden_id, type, x, z } = request.data as {
      garden_id: string; type: string; x: number; z: number;
    };
    if (!garden_id || !type || typeof x !== 'number' || typeof z !== 'number') {
      throw new HttpsError('invalid-argument', 'Missing required fields.');
    }
    const cost = BUILDING_COSTS[type];
    if (cost === undefined) throw new HttpsError('invalid-argument', 'Unknown building type.');

    const db = admin.firestore();
    const result = await db.runTransaction(async (tx) => {
      const childRef = db.collection('children').doc(uid);
      const gardenRef = db.collection('gardens').doc(garden_id);
      const childSnap = await tx.get(childRef);
      const gardenSnap = await tx.get(gardenRef);
      if (!childSnap.exists) throw new HttpsError('not-found', 'Profile not found.');
      if (!gardenSnap.exists) throw new HttpsError('not-found', 'World not found.');

      const child = childSnap.data() as any;
      const garden = gardenSnap.data() as any;
      if (garden.phase !== 'building') {
        throw new HttpsError('failed-precondition', 'Fully clean your world to unlock building.');
      }
      const points = child.energy_points ?? 0;
      if (points < cost) {
        throw new HttpsError('failed-precondition', `Need ${cost} energy points — you have ${points}.`);
      }
      const buildings: Building[] = Array.isArray(garden.buildings) ? garden.buildings : [];
      if (buildings.some((b) => b.x === x && b.z === z)) {
        throw new HttpsError('already-exists', 'That spot is already taken.');
      }

      const newBuilding: Building = {
        id: `${type}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        type, x, z,
        placed_at: admin.firestore.Timestamp.now(),
      };
      tx.update(gardenRef, { buildings: [...buildings, newBuilding] });
      tx.update(childRef, { energy_points: admin.firestore.FieldValue.increment(-cost) });
      return { building: newBuilding, remainingPoints: points - cost };
    });

    return { success: true, ...result };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// CALLABLE v2: Remove a building (bulldoze) — refunds half the cost
// ─────────────────────────────────────────────────────────────────────────────
export const removeBuilding = onCall(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in.');
    const uid = request.auth.uid;
    const { garden_id, building_id } = request.data as { garden_id: string; building_id: string };
    if (!garden_id || !building_id) throw new HttpsError('invalid-argument', 'Missing required fields.');

    const db = admin.firestore();
    const result = await db.runTransaction(async (tx) => {
      const childRef = db.collection('children').doc(uid);
      const gardenRef = db.collection('gardens').doc(garden_id);
      const gardenSnap = await tx.get(gardenRef);
      if (!gardenSnap.exists) throw new HttpsError('not-found', 'World not found.');

      const garden = gardenSnap.data() as any;
      const buildings: Building[] = Array.isArray(garden.buildings) ? garden.buildings : [];
      const target = buildings.find((b) => b.id === building_id);
      if (!target) throw new HttpsError('not-found', 'Building not found.');

      const refund = Math.floor((BUILDING_COSTS[target.type] ?? 0) * BUILDING_REFUND_RATE);
      tx.update(gardenRef, { buildings: buildings.filter((b) => b.id !== building_id) });
      if (refund > 0) tx.update(childRef, { energy_points: admin.firestore.FieldValue.increment(refund) });
      return { refund };
    });

    return { success: true, ...result };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// CALLABLE v2: Get garden state (for frontend reads that need server validation)
// ─────────────────────────────────────────────────────────────────────────────
export const getGardenState = onCall(
  { region: 'us-central1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const { garden_id } = request.data as { garden_id: string };
    if (!garden_id) {
      throw new HttpsError('invalid-argument', 'garden_id is required.');
    }

    const gardenSnap = await admin.firestore().collection('gardens').doc(garden_id).get();

    if (!gardenSnap.exists) {
      throw new HttpsError('not-found', 'Garden not found.');
    }

    return gardenSnap.data();
  }
);
