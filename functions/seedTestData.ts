import * as admin from 'firebase-admin';

// Connect to local emulators (development only)
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';

admin.initializeApp({
  projectId: 'greenpulse-dev-63b4b', // real Firebase project ID
});

const db = admin.firestore();
const auth = admin.auth();

async function main() {
  // Create a test anonymous user (UID will be auto‑generated)
  const userRecord = await auth.createUser({});
  const uid = userRecord.uid;
  console.log('Created anonymous user:', uid);

  // Create child profile
  await db.collection('children').doc(uid).set({
    energy_points: 100,
    current_streak: 5,
    parent_approved: true,
    nickname: 'TestKid',
    garden_id: 'garden_karachi_01',
    last_action_at: null,
    fcm_token: null,
  });
  console.log('Created child profile');

  // Ensure garden document exists
  const gardenRef = db.collection('gardens').doc('garden_karachi_01');
  const gardenSnap = await gardenRef.get();
  if (!gardenSnap.exists) {
    await gardenRef.set({
      health: 100,
      water_level: 50,
      nutrient_level: 50,
      created_at: new Date().toISOString(),
    });
    console.log('Created garden document');
  }

  // Create a dummy action for testing
  const actionRef = db.collection('actions').doc();
  await actionRef.set({
    child_id: uid,
    garden_id: 'garden_karachi_01',
    type: 'test-action',
    status: 'verified',
    created_at: new Date().toISOString(),
  });
  console.log('Created test action');
}

main().catch(err => {
  console.error('Error seeding test data:', err);
  process.exit(1);
});
