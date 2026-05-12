import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions/v1';
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

