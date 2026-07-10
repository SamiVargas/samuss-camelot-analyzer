import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  doc,
  getFirestore,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { firebaseConfig } from "./firebase/firebaseConfig.js";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const database = getFirestore(firebaseApp);

/**
 * Valida el formato del correo antes de llamar a Firebase.
 */
export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

/**
 * Traduce errores tecnicos de Firebase a mensajes amigables para el usuario.
 */
export function getFriendlyAuthError(error) {
  const messages = {
    "auth/email-already-in-use": "Este correo ya tiene una cuenta registrada.",
    "auth/invalid-email": "Ingresa un correo electronico valido.",
    "auth/invalid-credential": "El correo o la contrasena no son correctos.",
    "auth/missing-password": "La contrasena es obligatoria.",
    "auth/weak-password": "La contrasena debe tener al menos 6 caracteres.",
    "auth/network-request-failed": "No hay conexion con Firebase.",
    "auth/too-many-requests": "Demasiados intentos. Espera un momento e intenta otra vez."
  };

  return messages[error.code] || "No se pudo completar la accion. Intenta nuevamente.";
}

/**
 * Crea una cuenta con Firebase Authentication y guarda metadata publica en Firestore.
 */
export async function createAccount(email, password) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);

  await setDoc(doc(database, "users", credential.user.uid), {
    email: credential.user.email,
    createdAt: serverTimestamp(),
    lastLoginAt: serverTimestamp()
  });

  return credential.user;
}

/**
 * Inicia sesion con correo y contrasena usando Firebase Authentication.
 */
export async function loginWithEmail(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email, password);

  await setDoc(
    doc(database, "users", credential.user.uid),
    {
      email: credential.user.email,
      lastLoginAt: serverTimestamp()
    },
    { merge: true }
  );

  return credential.user;
}

/**
 * Cierra la sesion activa de Firebase.
 */
export async function logoutUser() {
  await signOut(auth);
}

/**
 * Observa cambios de sesion para proteger las pantallas.
 */
export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}
