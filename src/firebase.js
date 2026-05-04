import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  doc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore';

// These values are public-by-design (Firebase web SDK keys are not secrets).
// Security is enforced via Firestore Rules, not by hiding the config.
// They get bundled at build time from .env / GitHub Action secrets.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

const COLLECTION = 'questions';

export async function addQuestion(payload) {
  return addDoc(collection(db, COLLECTION), {
    ...payload,
    status: 'new',
    reply: null,
    repliedAt: null,
    createdAt: serverTimestamp(),
  });
}

export function subscribeQuestions(callback) {
  const q = query(collection(db, COLLECTION), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    const items = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        // Convert Firestore Timestamp to millis for easy display
        createdAt: data.createdAt?.toMillis?.() ?? Date.now(),
        repliedAt: data.repliedAt?.toMillis?.() ?? null,
      };
    });
    callback(items);
  });
}

export async function updateQuestion(id, patch) {
  const ref = doc(db, COLLECTION, id);
  const finalPatch = { ...patch };
  if (patch.status === 'replied' && !patch.repliedAt) {
    finalPatch.repliedAt = serverTimestamp();
  }
  return updateDoc(ref, finalPatch);
}

export async function deleteQuestion(id) {
  return deleteDoc(doc(db, COLLECTION, id));
}
