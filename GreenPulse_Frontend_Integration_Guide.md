# GreenPulse — React Native Integration Guide (For M2)

> **Project:** GreenPulse — The Collaborative Carbon Garden  
> **Firebase Project ID:** `greenpulse-dev-63b4b`  
> **Backend Region:** `us-central1`  
> **Last Updated:** 2026-05-13

---

## 1. Firebase Setup in React Native

### 1.1 Install Dependencies

```bash
npm install @react-native-firebase/app
npm install @react-native-firebase/auth
npm install @react-native-firebase/firestore
npm install @react-native-firebase/functions
npm install @react-native-firebase/storage
npm install @react-native-firebase/messaging
```

### 1.2 Connect to Firebase Project

Download config files from **Firebase Console → Project Settings → Your Apps**:

| Platform | Config File | Place In |
|----------|------------|----------|
| Android | `google-services.json` | `android/app/google-services.json` |
| iOS | `GoogleService-Info.plist` | `ios/YourApp/GoogleService-Info.plist` |

> **How does React Native know which backend to connect to?**  
> These config files contain the unique project ID (`greenpulse-dev-63b4b`), API keys, and app IDs. Once placed correctly, ALL Firebase SDK calls automatically route to the correct project. No manual URLs needed.

If the app isn't registered yet:
1. Go to https://console.firebase.google.com/project/greenpulse-dev-63b4b/settings/general
2. Click **"Add app"** → Select Android or iOS
3. Enter your app's package name / bundle ID
4. Download the config file

---

## 2. How the Frontend Communicates with the Backend

There are **NO REST APIs**. Communication happens through three Firebase mechanisms:

| Mechanism | When to Use |
|-----------|------------|
| **Callable Functions** | Triggering backend actions (submit photo, delete data, get garden) |
| **Firestore Listeners** | Real-time UI updates (garden state, child profile, action status) |
| **FCM Push Notifications** | Alerts from the Decay and Waterer agents |

---

## 3. Authentication

The app uses **Firebase Anonymous Auth** (COPPA-safe — no PII collected from children).

```javascript
import auth from '@react-native-firebase/auth';

// Sign in anonymously
const userCredential = await auth().signInAnonymously();
const uid = userCredential.user.uid;
```

After first sign-in, create the child document in Firestore:

```javascript
import firestore from '@react-native-firebase/firestore';

const uid = auth().currentUser.uid;
const childRef = firestore().collection('children').doc(uid);
const childSnap = await childRef.get();

if (!childSnap.exists) {
  await childRef.set({
    energy_points: 0,
    current_streak: 0,
    parent_approved: false,
    nickname: null,
    garden_id: 'garden_karachi_01',  // assign to a garden
    last_action_at: null,
    fcm_token: null,
  });
}
```

> **Important:** `parent_approved` starts as `false`. A parent must approve the child before they can submit actions.

---

## 4. Callable Functions

These are the 3 backend endpoints. Call them using `@react-native-firebase/functions`.

```javascript
import functions from '@react-native-firebase/functions';

// IMPORTANT: Set the region to match the backend
const fn = functions().httpsCallable('functionName');
// OR if you need to specify region:
// const fn = firebase.app().functions('us-central1').httpsCallable('functionName');
```

---

### 4.1 `submitAction` — Submit an Eco-Action

Called after the child takes a photo. **Photo must be uploaded to Storage first** (see Section 6).

```javascript
const submitAction = functions().httpsCallable('submitAction');

try {
  const result = await submitAction({
    action_type: 'recycle_bottle',     // see Action Types below
    photo_url: photoDownloadUrl,        // Firebase Storage download URL
    garden_id: 'garden_karachi_01',     // the child's garden ID
  });

  console.log(result.data);
  // {
  //   success: true,
  //   action_id: "abc123...",
  //   message: "Action submitted for verification."
  // }

  // Now listen to /actions/{action_id} for the AI result (see Section 5.3)
} catch (error) {
  // error.code will be one of the error codes below
  console.error(error.code, error.message);
}
```

**Action Types (use exactly these strings):**

| Action Type | Description | Points |
|-------------|-------------|--------|
| `recycle_bottle` | Plastic bottle in/near recycling bin | 10 |
| `plant_seed` | Freshly planted seed or sapling | 20 |
| `water_plant` | Watering a plant with can/hose/bottle | 6 |
| `pick_litter` | Before/after litter cleanup | 15 |
| `compost_waste` | Food scraps into compost bin | 18 |
| `turn_off_light` | Light switch OFF in unlit room | 5 |

**Error Codes:**

| Code | Meaning | UI Action |
|------|---------|-----------|
| `unauthenticated` | User not signed in | Redirect to sign-in |
| `invalid-argument` | Missing `action_type`, `photo_url`, or `garden_id` | Show validation error |
| `permission-denied` | `parent_approved` is `false` | Show "Waiting for parent approval" |

---

### 4.2 `getGardenState` — Get Garden Data

Can also use a Firestore listener instead (recommended for real-time updates).

```javascript
const getGardenState = functions().httpsCallable('getGardenState');

const result = await getGardenState({
  garden_id: 'garden_karachi_01',
});

console.log(result.data);
// { garden_health: 30, garden_stage: "seedling", water_level: 50, ... }
```

---

### 4.3 `deleteAllData` — COPPA Data Deletion

Called from the **parent dashboard** to delete all child data.

```javascript
const deleteAllData = functions().httpsCallable('deleteAllData');

const result = await deleteAllData();

console.log(result.data);
// { success: true, message: "All data deleted." }

// After this, sign the user out
await auth().signOut();
```

> ⚠️ **This is irreversible.** It deletes:
> - Child's Firestore profile
> - All action documents
> - All photos from Storage
> - The Firebase Auth account

---

## 5. Firestore Real-Time Listeners

Use these for live UI updates — **do NOT poll the callable functions**.

### 5.1 Garden State (Garden Screen — Main Screen)

**Path:** `gardens/{gardenId}`

```javascript
import firestore from '@react-native-firebase/firestore';

useEffect(() => {
  const unsubscribe = firestore()
    .collection('gardens')
    .doc('garden_karachi_01')
    .onSnapshot((snapshot) => {
      const data = snapshot.data();

      const health     = data.garden_health;    // 0–100 (number)
      const stage      = data.garden_stage;     // string, see stages below
      const waterLevel = data.water_level;      // 0–100 (number)
      const nutrient   = data.nutrient_level;   // 0–100 (number)
      const queue      = data.action_queue;     // array of pending action IDs
      const members    = data.member_count;     // number

      // Update your garden UI + Zara based on these values
    });

  return () => unsubscribe();
}, []);
```

**Garden Stages (drives Zara's visual state):**

| Stage | Health Range | Visual |
|-------|-------------|--------|
| `barren` | 0–19 | Dead/empty plot |
| `seedling` | 20–39 | Small sprout |
| `sapling` | 40–59 | Young tree |
| `tree` | 60–79 | Full tree |
| `forest` | 80–100 | Lush forest, Zara celebrating |

---

### 5.2 Child Profile (Profile Screen + Camera Gate)

**Path:** `children/{uid}`

```javascript
useEffect(() => {
  const uid = auth().currentUser.uid;

  const unsubscribe = firestore()
    .collection('children')
    .doc(uid)
    .onSnapshot((snapshot) => {
      const data = snapshot.data();

      const points         = data.energy_points;     // number
      const streak         = data.current_streak;     // number
      const parentApproved = data.parent_approved;    // boolean
      const nickname       = data.nickname;           // string | null
      const gardenId       = data.garden_id;          // string
    });

  return () => unsubscribe();
}, []);
```

> **Camera Gate:** Before opening the camera, check `parent_approved === true`. If `false`, show the "Waiting for parent approval" screen.

---

### 5.3 Action Status (Zara Reaction Screen)

After calling `submitAction`, listen to the action document to show Zara's reaction in real-time.

```javascript
const listenToAction = (actionId) => {
  return firestore()
    .collection('actions')
    .doc(actionId)
    .onSnapshot((snapshot) => {
      const data = snapshot.data();

      const status     = data.status;          // 'pending' | 'verified' | 'rejected'
      const confidence = data.confidence;       // 0.0–1.0
      const label      = data.detected_label;   // what AI detected in the photo

      switch (status) {
        case 'pending':
          // Show Zara "thinking" animation
          break;
        case 'verified':
          // Show Zara "happy" animation + points earned
          break;
        case 'rejected':
          // Show Zara "sad" animation + "Try Again" button
          break;
      }
    });
};

// Usage after submitAction:
const result = await submitAction({ ... });
const unsubscribe = listenToAction(result.data.action_id);

// Clean up when leaving the screen
unsubscribe();
```

---

## 6. Photo Upload to Firebase Storage

Photos **must be uploaded to Storage BEFORE calling `submitAction`**. The backend downloads them server-side for AI verification.

**Storage Path:** `action-photos/{uid}/{photoId}`

```javascript
import storage from '@react-native-firebase/storage';
import auth from '@react-native-firebase/auth';

async function uploadActionPhoto(photoUri) {
  const uid = auth().currentUser.uid;
  const photoId = Date.now().toString();
  const storagePath = `action-photos/${uid}/${photoId}.jpg`;

  const ref = storage().ref(storagePath);

  // Upload the file
  await ref.putFile(photoUri, {
    contentType: 'image/jpeg',
  });

  // Get download URL to pass to submitAction
  const downloadUrl = await ref.getDownloadURL();
  return downloadUrl;
}

// Full flow:
// 1. Capture photo with camera
// 2. Upload to Storage
// 3. Call submitAction with the download URL
// 4. Listen to the action document for the result
```

**Storage Rules (already deployed):**
- Max file size: **5 MB**
- Only images allowed (`image/*`)
- Users can only upload to their own folder
- Users can only read their own photos
- **The backend deletes the photo after verification** (COPPA compliance)

---

## 7. FCM Push Notifications

The backend sends push notifications when the garden needs attention.

### 7.1 Save FCM Token

After sign-in, save the device's FCM token to the child document:

```javascript
import messaging from '@react-native-firebase/messaging';
import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';

// Request permission (required on iOS)
await messaging().requestPermission();

// Get token and save to Firestore
const token = await messaging().getToken();
const uid = auth().currentUser.uid;

await firestore()
  .collection('children')
  .doc(uid)
  .update({ fcm_token: token });

// Listen for token refresh
messaging().onTokenRefresh(async (newToken) => {
  await firestore()
    .collection('children')
    .doc(uid)
    .update({ fcm_token: newToken });
});
```

### 7.2 Handle Notifications

Notifications include a `data` payload with Zara's state:

```javascript
// Foreground notifications
messaging().onMessage(async (remoteMessage) => {
  const { data } = remoteMessage;

  if (data.type === 'zara_state') {
    const zaraState = data.zara_state;  // 'thirsty' | 'sad'
    const gardenId  = data.garden_id;

    // Update Zara's animation based on state
  }
});

// Background / killed state notifications
messaging().setBackgroundMessageHandler(async (remoteMessage) => {
  // Handle background notification
  console.log('Background message:', remoteMessage);
});
```

### 7.3 Zara State Mapping

| FCM `zara_state` | Trigger | Zara Animation | Notification Text |
|-------------------|---------|----------------|-------------------|
| `thirsty` | `water_level < 20` | Tongue out, dry texture | "🌵 Zara is thirsty! Your garden needs water." |
| `sad` | `garden_health < 30` | Droops, rain cloud | "🌧️ Zara is sad! Your garden needs help!" |
| `happy` | Action verified | Jumps, sparkles | *(via Firestore listener, not FCM)* |
| `celebrating` | `garden_stage === 'forest'` | Crown, Ajrak coat glows | *(via Firestore listener)* |

---

## 8. Complete User Flow

```
┌─────────────────────────────────────────────────────────────┐
│                  REACT NATIVE APP FLOW                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Anonymous Sign-In                                       │
│     └── auth().signInAnonymously()                          │
│     └── Create child doc in /children/{uid} if new user     │
│     └── Save FCM token to child doc                         │
│                                                             │
│  2. Check parent_approved                                   │
│     └── Listen to /children/{uid}                           │
│     └── If false → Show "Waiting for parent" screen         │
│                                                             │
│  3. Garden Screen (main screen)                             │
│     └── Listen to /gardens/{gardenId}                       │
│     └── Display Zara + garden visuals based on stage        │
│     └── Show health/water/nutrient bars                     │
│                                                             │
│  4. Take Eco-Action                                         │
│     ├── a. Open camera, capture photo                       │
│     ├── b. Upload to Storage: action-photos/{uid}/...       │
│     ├── c. Call submitAction({ action_type, photo_url,      │
│     │       garden_id })                                    │
│     ├── d. Get action_id from response                      │
│     └── e. Listen to /actions/{action_id} for AI result     │
│                                                             │
│  5. Zara Reaction Screen                                    │
│     ├── pending  → Zara thinking animation                  │
│     ├── verified → Zara happy + show points earned          │
│     └── rejected → Zara sad + "Try Again" button            │
│                                                             │
│  6. Profile Screen                                          │
│     └── Listen to /children/{uid}                           │
│     └── Show energy_points, current_streak                  │
│                                                             │
│  7. Parent Dashboard                                        │
│     └── "Delete All Data" button → calls deleteAllData()    │
│     └── After deletion → auth().signOut()                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. Firestore Data Structures (Reference)

### `gardens/{gardenId}`
```json
{
  "garden_health": 30,
  "garden_stage": "seedling",
  "water_level": 50,
  "nutrient_level": 50,
  "action_queue": [],
  "member_count": 1,
  "created_at": "<Timestamp>"
}
```

### `children/{uid}`
```json
{
  "energy_points": 0,
  "current_streak": 0,
  "parent_approved": false,
  "nickname": null,
  "garden_id": "garden_karachi_01",
  "last_action_at": null,
  "fcm_token": null
}
```

### `actions/{actionId}`
```json
{
  "child_uid": "user_uid_here",
  "garden_id": "garden_karachi_01",
  "action_type": "recycle_bottle",
  "status": "pending",
  "confidence": 0,
  "detected_label": "",
  "photo_url": "https://firebasestorage.googleapis.com/...",
  "created_at": "<Timestamp>",
  "processed_at": null
}
```

### `reward_log/{logId}` (read-only, for parent dashboard)
```json
{
  "child_uid": "user_uid_here",
  "garden_id": "garden_karachi_01",
  "action_type": "recycle_bottle",
  "points_awarded": 10,
  "streak": 1,
  "multiplier_applied": false,
  "created_at": "<Timestamp>"
}
```

---

## 10. Test Data (Already Seeded in Firestore)

These documents exist in the dev environment for testing:

| Collection | Document ID | Notes |
|-----------|-------------|-------|
| `gardens` | `garden_karachi_01` | health: 30, water: 50, stage: seedling |
| `children` | `test_child_001` | parent_approved: true, linked to garden_karachi_01 |

---

## 11. Quick Checklist for React Native Dev

- [ ] Add Firebase to your RN project (`@react-native-firebase/app`)
- [ ] Place `google-services.json` in `android/app/`
- [ ] Place `GoogleService-Info.plist` in `ios/YourApp/`
- [ ] Implement anonymous sign-in
- [ ] Create child document in Firestore after first sign-in
- [ ] Save FCM token to child document
- [ ] Implement camera + photo upload to Firebase Storage
- [ ] Call `submitAction` after photo upload
- [ ] Listen to `/actions/{actionId}` for Zara reaction (pending → verified/rejected)
- [ ] Listen to `/gardens/{gardenId}` for real-time garden state
- [ ] Listen to `/children/{uid}` for points, streak, and parent approval gate
- [ ] Handle FCM notifications (thirsty/sad Zara states)
- [ ] Implement parent approval flow
- [ ] Implement "Delete All Data" button (COPPA compliance)
