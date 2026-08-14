// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  PRIME SALON — Firebase Engine (firebaseEngine.js)                        ║
// ║                                                                           ║
// ║  This single file contains:                                               ║
// ║    § 1  Firebase Admin SDK Initialization                                 ║
// ║    § 2  Slot Locking — Atomic transactions for double-booking prevention  ║
// ║    § 3  Booking Confirmation — Appointment creation + WhatsApp trigger     ║
// ║    § 4  Appointment Management — Cancel, update status, queries           ║
// ║    § 5  Slot Availability — Check & list open slots                       ║
// ║                                                                           ║
// ║  EXPORTS:                                                                 ║
// ║    getDb, lockSlot, releaseLock, confirmBooking, cancelAppointment,        ║
// ║    updateStatus, isSlotAvailable, getAvailableSlots,                      ║
// ║    getAppointmentsByDate, getAppointmentById                              ║
// ╚════════════════════════════════════════════════════════════════════════════╝

const admin = require("firebase-admin");

// WhatsApp module — loaded lazily to avoid circular dependency issues.
// server.js requires this file first (for Firebase init), and whatsappBot.js
// doesn't depend on Firebase, so no cycle exists. We still lazy-load
// as a safety pattern.
let _whatsapp = null;
function whatsapp() {
  if (!_whatsapp) _whatsapp = require("./whatsappBot");
  return _whatsapp;
}

const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5-minute slot hold


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 1  FIREBASE ADMIN SDK INITIALIZATION                                 │
// │                                                                         │
// │  Supports three credential sources:                                     │
// │    A) FIREBASE_SERVICE_ACCOUNT_JSON env var (Render / production)        │
// │       → Paste your entire service-account JSON as one line              │
// │    B) FIREBASE_SERVICE_ACCOUNT_PATH env var (local dev)                  │
// │       → Path to your downloaded .json key file                          │
// │    C) Application Default Credentials (GCP environments)                │
// └─────────────────────────────────────────────────────────────────────────┘

let db = null;

(function initFirebase() {
  if (admin.apps.length > 0) { db = admin.database(); return; }

  let credential;

  // Option A — JSON string in env var (recommended for Render)
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      credential = admin.credential.cert(sa);
    } catch (err) {
      console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", err.message);
      process.exit(1);
    }
  }
  // Option B — file path (local dev convenience)
  else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    try {
      const sa = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      credential = admin.credential.cert(sa);
    } catch (err) {
      console.error("❌ Failed to load service account file:", err.message);
      process.exit(1);
    }
  }
  // Option C — ADC fallback
  else {
    console.warn("⚠️  No Firebase credentials found — using application default credentials.");
    credential = admin.credential.applicationDefault();
  }

  admin.initializeApp({
    credential,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });

  db = admin.database();
  console.log("✅ Firebase Admin initialized");
})();

/**
 * Return the initialized Firebase Realtime Database instance.
 * Used by server.js for direct queries (admin CRUD, webhook, scheduler).
 */
function getDb() {
  if (!db) throw new Error("Firebase not initialized.");
  return db;
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  HELPERS                                                                │
// └─────────────────────────────────────────────────────────────────────────┘

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 2  SLOT LOCKING — Firebase Transactions                              │
// │                                                                         │
// │  How it prevents double-booking:                                        │
// │                                                                         │
// │  Firebase's `transaction()` does an atomic read-modify-write on a       │
// │  single JSON path. Two customers hitting the same slot at the same      │
// │  millisecond → Firebase serializes them → exactly one wins.             │
// │                                                                         │
// │  The lock lifecycle:                                                     │
// │    1. Customer picks slot → lockSlot() reserves it for 5 min            │
// │    2a. Customer confirms  → confirmBooking() marks it permanent         │
// │    2b. Customer abandons  → lock auto-expires, slot reopens             │
// │    3.  Admin cancels      → cancelAppointment() removes the lock        │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Attempt to atomically lock a slot for a customer's session.
 *
 * @param {string} date       "2026-08-12"
 * @param {string} timeSlot   "02:00 PM"
 * @param {string} stylistId  "stl_001"
 * @param {string} sessionId  Unique browser session identifier
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
async function lockSlot(date, timeSlot, stylistId, sessionId) {
  const slotRef = db.ref(`slot_locks/${date}/${timeSlot}/${stylistId}`);

  try {
    const result = await slotRef.transaction((current) => {
      const now = Date.now();

      // CASE 1: Slot is completely free
      if (current === null || !current.locked) {
        return { locked: true, locked_by: sessionId, locked_at: now, confirmed: false };
      }

      // CASE 2: Slot was locked but never confirmed AND the lock has expired
      //         → customer abandoned → safe to take over
      if (current.locked && !current.confirmed && now - current.locked_at > LOCK_TIMEOUT_MS) {
        return { locked: true, locked_by: sessionId, locked_at: now, confirmed: false };
      }

      // CASE 3: Slot is actively locked (by someone else, or confirmed)
      //         → return undefined to ABORT the transaction
      return undefined;
    });

    return result.committed
      ? { success: true }
      : { success: false, reason: "Slot is currently unavailable" };
  } catch (error) {
    console.error("lockSlot error:", error.message);
    return { success: false, reason: "Server error during slot locking" };
  }
}


/**
 * Release a lock — only if it belongs to the given session and isn't confirmed.
 * Called when the customer navigates away before completing the booking.
 */
async function releaseLock(date, timeSlot, stylistId, sessionId) {
  const slotRef = db.ref(`slot_locks/${date}/${timeSlot}/${stylistId}`);

  try {
    await slotRef.transaction((current) => {
      if (current && current.locked_by === sessionId && !current.confirmed) {
        return null; // Delete the lock
      }
      return current; // Not ours → leave it alone
    });
    return { success: true };
  } catch (error) {
    console.error("releaseLock error:", error.message);
    return { success: false, reason: error.message };
  }
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 3  BOOKING CONFIRMATION                                              │
// │                                                                         │
// │  Full booking flow in one function:                                      │
// │    1. Write /appointments/{id}                                          │
// │    2. Permanently confirm the slot lock                                 │
// │    3. Upsert the customer in /users                                     │
// │    4. Fire-and-forget WhatsApp confirmation message                     │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Confirm a booking.
 *
 * @param {Object} data  Appointment fields (customer_name, phone, service, stylist, date, time, price, etc.)
 * @returns {Promise<{success: boolean, appointmentId?: string, appointment?: Object, whatsapp?: Object}>}
 */
async function confirmBooking(data) {
  const appointmentId = genId("apt");

  try {
    // ── 1. Write the appointment record ──
    const appointmentData = {
      ...data,
      status: "confirmed",
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await db.ref(`appointments/${appointmentId}`).set(appointmentData);

    // ── 2. Permanently confirm the slot lock ──
    await db.ref(`slot_locks/${data.date}/${data.time_slot}/${data.stylist_id}`).set({
      locked: true,
      locked_by: appointmentId,
      locked_at: Date.now(),
      confirmed: true,
    });

    // ── 3. Upsert customer ──
    const usersSnap = await db
      .ref("users")
      .orderByChild("phone")
      .equalTo(data.customer_phone)
      .once("value");

    if (usersSnap.exists()) {
      const userId   = Object.keys(usersSnap.val())[0];
      const existing = usersSnap.val()[userId];
      await db.ref(`users/${userId}`).update({
        total_visits: (existing.total_visits || 0) + 1,
        last_visit: data.date,
      });
    } else {
      const userId = genId("usr");
      await db.ref(`users/${userId}`).set({
        name: data.customer_name,
        phone: data.customer_phone,
        email: data.customer_email || "",
        total_visits: 1,
        last_visit: data.date,
        created_at: Date.now(),
      });
    }

    // ── 4. WhatsApp confirmation (async — don't block the API response) ──
    const waResult = whatsapp().sendConfirmation(appointmentData).catch(err => {
      console.error("WhatsApp confirmation failed:", err.message);
      return { success: false, error: err.message };
    });

    console.log(`✅ Booking confirmed: ${appointmentId} — ${data.customer_name}`);

    return {
      success: true,
      appointmentId,
      appointment: appointmentData,
      whatsapp: await waResult,
    };
  } catch (error) {
    console.error("confirmBooking error:", error.message);
    return { success: false, reason: error.message };
  }
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 4  APPOINTMENT MANAGEMENT                                            │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Cancel an appointment — update its status and release the slot lock.
 * Also sends a WhatsApp cancellation notice to the customer.
 */
async function cancelAppointment(appointmentId) {
  try {
    const snap = await db.ref(`appointments/${appointmentId}`).once("value");
    if (!snap.exists()) return { success: false, reason: "Appointment not found" };

    const apt = snap.val();

    // Update status
    await db.ref(`appointments/${appointmentId}`).update({
      status: "cancelled",
      updated_at: Date.now(),
    });

    // Release the slot lock so it becomes bookable again
    await db.ref(`slot_locks/${apt.date}/${apt.time_slot}/${apt.stylist_id}`).remove();

    // Notify customer (fire-and-forget)
    whatsapp().sendCancellation(apt).catch(err => {
      console.error("WhatsApp cancellation notice failed:", err.message);
    });

    return { success: true };
  } catch (error) {
    console.error("cancelAppointment error:", error.message);
    return { success: false, reason: error.message };
  }
}


/**
 * Update appointment status (confirmed, completed, cancelled, no-show).
 * Handles side effects:
 *   - "cancelled"  → releases slot lock + sends cancellation WhatsApp
 *   - "completed"  → sends thank-you WhatsApp
 */
async function updateStatus(appointmentId, newStatus) {
  try {
    const snap = await db.ref(`appointments/${appointmentId}`).once("value");
    if (!snap.exists()) return { success: false, reason: "Appointment not found" };

    const apt = snap.val();

    await db.ref(`appointments/${appointmentId}`).update({
      status: newStatus,
      updated_at: Date.now(),
    });

    // Side effects
    if (newStatus === "cancelled") {
      await db.ref(`slot_locks/${apt.date}/${apt.time_slot}/${apt.stylist_id}`).remove();
      whatsapp().sendCancellation(apt).catch(() => {});
    } else if (newStatus === "completed") {
      whatsapp().sendThankYou(apt).catch(() => {});
    }

    return { success: true };
  } catch (error) {
    console.error("updateStatus error:", error.message);
    return { success: false, reason: error.message };
  }
}


/**
 * Get all appointments for a specific date.
 * Returns an object of { appointmentId: data } or empty object.
 */
async function getAppointmentsByDate(date) {
  try {
    const snap = await db.ref("appointments").orderByChild("date").equalTo(date).once("value");
    return snap.exists() ? snap.val() : {};
  } catch (error) {
    console.error("getAppointmentsByDate error:", error.message);
    return {};
  }
}


/**
 * Get a single appointment by its ID.
 */
async function getAppointmentById(appointmentId) {
  try {
    const snap = await db.ref(`appointments/${appointmentId}`).once("value");
    return snap.exists() ? snap.val() : null;
  } catch {
    return null;
  }
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 5  SLOT AVAILABILITY                                                 │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Check if one specific slot is available.
 * Considers expired unconfirmed locks as available.
 *
 * @returns {Promise<boolean>}
 */
async function isSlotAvailable(date, timeSlot, stylistId) {
  try {
    const snap = await db.ref(`slot_locks/${date}/${timeSlot}/${stylistId}`).once("value");
    if (!snap.exists()) return true;

    const data = snap.val();
    if (!data.locked) return true;

    // Expired unconfirmed lock → treat as available
    if (!data.confirmed && Date.now() - data.locked_at > LOCK_TIMEOUT_MS) return true;

    return false;
  } catch {
    return false; // Fail closed — assume unavailable if we can't check
  }
}


/**
 * Get ALL available time slots for a given date + stylist.
 * Returns an array of available time strings from the provided list.
 *
 * @param {string}   date           "2026-08-12"
 * @param {string}   stylistId      "stl_001"
 * @param {string[]} allTimeSlots   Full list of possible slots
 * @returns {Promise<string[]>}     Only the slots that are open
 */
async function getAvailableSlots(date, stylistId, allTimeSlots) {
  try {
    const snap  = await db.ref(`slot_locks/${date}`).once("value");
    const locks = snap.exists() ? snap.val() : {};

    return allTimeSlots.filter(time => {
      const lock = locks[time]?.[stylistId];
      if (!lock || !lock.locked) return true;
      if (!lock.confirmed && Date.now() - lock.locked_at > LOCK_TIMEOUT_MS) return true;
      return false;
    });
  } catch {
    return [];
  }
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  EXPORTS                                                                │
// └─────────────────────────────────────────────────────────────────────────┘

module.exports = {
  getDb,
  lockSlot,
  releaseLock,
  confirmBooking,
  cancelAppointment,
  updateStatus,
  isSlotAvailable,
  getAvailableSlots,
  getAppointmentsByDate,
  getAppointmentById,
};
