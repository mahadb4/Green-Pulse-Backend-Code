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
