// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  PRIME SALON — Monolithic Backend Server (server.js)                      ║
// ║                                                                           ║
// ║  This single file contains:                                               ║
// ║    § 1  Dependencies & Config                                             ║
// ║    § 2  Express App Setup & Middleware                                     ║
// ║    § 3  Admin PIN Auth Middleware                                          ║
// ║    § 4  Routes — Health Check                                             ║
// ║    § 5  Routes — Appointment Booking (lock / release / book / slots)       ║
// ║    § 6  Routes — WhatsApp Webhook (incoming messages + status)             ║
// ║    § 7  Routes — Admin (services CRUD, stylists, stats, public endpoints)  ║
// ║    § 8  Error Handling (404 + global)                                      ║
// ║    § 9  Cron Scheduler (reminders, lock cleanup, no-show)                  ║
// ║    § 10 Server Start & Graceful Shutdown                                  ║
// ║                                                                           ║
// ║  Companion files: firebaseEngine.js, whatsappBot.js                       ║
// ╚════════════════════════════════════════════════════════════════════════════╝

require("dotenv").config();


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 1  DEPENDENCIES & CONFIG                                            │
// └─────────────────────────────────────────────────────────────────────────┘

const express     = require("express");
const cors        = require("cors");
const helmet      = require("helmet");
const morgan      = require("morgan");
const compression = require("compression");
const rateLimit   = require("express-rate-limit");
const cron        = require("node-cron");

// Our two companion modules
const engine   = require("./firebaseEngine");
const whatsapp = require("./whatsappBot");

const PORT      = process.env.PORT || 3001;
const NODE_ENV  = process.env.NODE_ENV || "development";
const ADMIN_PIN = process.env.ADMIN_PIN || "9400";
const SALON_NAME = process.env.SALON_NAME || "Prime Salon";

// All valid 30-minute time slots the salon offers
const TIME_SLOTS = [
  "10:00 AM","10:30 AM","11:00 AM","11:30 AM","12:00 PM","12:30 PM",
  "01:00 PM","01:30 PM","02:00 PM","02:30 PM","03:00 PM","03:30 PM",
  "04:00 PM","04:30 PM","05:00 PM","05:30 PM","06:00 PM","06:30 PM",
  "07:00 PM","07:30 PM","08:00 PM","08:30 PM",
];

const VALID_STATUSES = ["pending", "confirmed", "completed", "cancelled", "no-show"];


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 2  EXPRESS APP SETUP & MIDDLEWARE                                    │
// └─────────────────────────────────────────────────────────────────────────┘

const app = express();

// Security headers — allow Firebase SDK, Google Fonts & inline scripts
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.gstatic.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https://*.firebaseio.com", "https://*.firebasedatabase.app", "wss://*.firebaseio.com", "wss://*.firebasedatabase.app"],
      imgSrc: ["'self'", "data:", "https:"],
      frameSrc: ["'self'"]
    }
  }
}));

// Gzip compression for all responses
app.use(compression());

// Request logging — verbose in production, concise in dev
app.use(morgan(NODE_ENV === "production" ? "combined" : "dev"));

// CORS — whitelist your frontend domain(s)
const corsOrigins = (process.env.CORS_ORIGINS || "http://localhost:3000")
  .split(",").map(s => s.trim());

app.use(cors({
  origin: corsOrigins,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-admin-pin"],
  credentials: true,
}));

// Body parsing — JSON for API calls, URL-encoded for Twilio webhooks
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Global rate limiter — 100 requests per 15 min per IP
app.use("/api/", rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { success: false, error: "Too many requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
}));

// Stricter rate limit on booking endpoints to prevent slot-spam
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute window
  max: 10,               // 10 requests per minute per IP
  message: { success: false, error: "Booking rate limit exceeded. Please wait." },
});


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 3  ADMIN PIN AUTH MIDDLEWARE                                         │
// │                                                                         │
// │  Simple PIN-based auth. The admin dashboard sends the PIN in the         │
// │  `x-admin-pin` header with every request. Attach `requireAdmin`         │
// │  to any route that needs protection.                                    │
// └─────────────────────────────────────────────────────────────────────────┘

function requireAdmin(req, res, next) {
  const pin = req.headers["x-admin-pin"];
  if (!pin)              return res.status(401).json({ success: false, error: "Admin PIN required in x-admin-pin header." });
  if (pin !== ADMIN_PIN) return res.status(403).json({ success: false, error: "Invalid admin PIN." });
  next();
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 4  ROUTES — HEALTH CHECK                                            │
// │                                                                         │
// │  Render pings this endpoint to verify the service is alive.             │
// │  Also useful for uptime monitors and debugging.                         │
// └─────────────────────────────────────────────────────────────────────────┘

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    service: "Prime Salon API",
    version: "1.0.0",
    environment: NODE_ENV,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 5  ROUTES — APPOINTMENT BOOKING                                      │
// │                                                                         │
// │  Customer-facing endpoints for the slot-locking booking flow:            │
// │    POST  /api/appointments/lock      Lock a slot (5 min hold)           │
// │    POST  /api/appointments/release   Release a held lock                │
// │    POST  /api/appointments/book      Confirm booking → WhatsApp msg     │
// │    GET   /api/appointments/slots     Available slots for date+stylist   │
// │    GET   /api/appointments/check     Check one specific slot            │
// │                                                                         │
// │  Admin-only endpoints:                                                  │
// │    GET   /api/appointments/date/:d   All bookings for a date            │
// │    PATCH /api/appointments/:id/status  Update status                    │
// │    DELETE /api/appointments/:id       Cancel appointment                │
// └─────────────────────────────────────────────────────────────────────────┘

// ── Lock a slot ──────────────────────────────────────────────────────────
// The customer picks a date/time/stylist → frontend calls this to reserve
// the slot for 5 minutes while they fill in their details.

app.post("/api/appointments/lock", bookingLimiter, async (req, res) => {
  const { date, time_slot, stylist_id, session_id } = req.body;

  if (!date || !time_slot || !stylist_id || !session_id) {
    return res.status(400).json({ success: false, error: "Missing required fields: date, time_slot, stylist_id, session_id" });
  }
  if (!TIME_SLOTS.includes(time_slot)) {
    return res.status(400).json({ success: false, error: "Invalid time slot" });
  }
  const slotDate = new Date(date);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (slotDate < today) {
    return res.status(400).json({ success: false, error: "Cannot book a past date" });
  }

  const result = await engine.lockSlot(date, time_slot, stylist_id, session_id);
  res.status(result.success ? 200 : 409).json(result);
});

// ── Release a lock ───────────────────────────────────────────────────────
// Called when the customer navigates away before confirming.

app.post("/api/appointments/release", async (req, res) => {
  const { date, time_slot, stylist_id, session_id } = req.body;
  if (!date || !time_slot || !stylist_id || !session_id) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  const result = await engine.releaseLock(date, time_slot, stylist_id, session_id);
  res.json(result);
});

// ── Confirm booking ──────────────────────────────────────────────────────
// Customer filled in details → create the appointment, lock the slot
// permanently, upsert the customer record, send WhatsApp confirmation.

app.post("/api/appointments/book", bookingLimiter, async (req, res) => {
  const required = [
    "customer_name", "customer_phone", "service_id", "service_name",
    "stylist_id", "stylist_name", "date", "time_slot", "duration_minutes", "price",
  ];
  const missing = required.filter(f => !req.body[f]);
  if (missing.length > 0) {
    return res.status(400).json({ success: false, error: `Missing: ${missing.join(", ")}` });
  }
  const phone = req.body.customer_phone.replace(/[\s\-()]/g, "");
  if (phone.length < 10) {
    return res.status(400).json({ success: false, error: "Invalid phone number" });
  }

  const result = await engine.confirmBooking({
    ...req.body,
    source: req.body.source || "online",
    notes: req.body.notes || "",
  });
  res.status(result.success ? 201 : 500).json(result);
});

// ── Get available slots ──────────────────────────────────────────────────
// Returns an array of open time strings for a date + stylist.

app.get("/api/appointments/slots", async (req, res) => {
  const { date, stylist_id } = req.query;
  if (!date || !stylist_id) {
    return res.status(400).json({ success: false, error: "Missing query params: date, stylist_id" });
  }
  const available = await engine.getAvailableSlots(date, stylist_id, TIME_SLOTS);
  res.json({ success: true, date, stylist_id, available_slots: available });
});

// ── Quick single-slot check ──────────────────────────────────────────────

app.get("/api/appointments/check", async (req, res) => {
  const { date, time_slot, stylist_id } = req.query;
  if (!date || !time_slot || !stylist_id) {
    return res.status(400).json({ success: false, error: "Missing query params" });
  }
  const available = await engine.isSlotAvailable(date, time_slot, stylist_id);
  res.json({ success: true, available });
});

// ── Admin: Get all appointments for a date ───────────────────────────────

app.get("/api/appointments/date/:date", requireAdmin, async (req, res) => {
  const appointments = await engine.getAppointmentsByDate(req.params.date);
  res.json({ success: true, date: req.params.date, appointments });
});

// ── Admin: Update appointment status ─────────────────────────────────────

app.patch("/api/appointments/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` });
  }
  const result = await engine.updateStatus(req.params.id, status);
  res.status(result.success ? 200 : 404).json(result);
});

// ── Admin: Cancel (delete) an appointment ────────────────────────────────

app.delete("/api/appointments/:id", requireAdmin, async (req, res) => {
  const result = await engine.cancelAppointment(req.params.id);
  res.status(result.success ? 200 : 404).json(result);
});


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 6  ROUTES — WHATSAPP WEBHOOK                                        │
// │                                                                         │
// │  Twilio sends incoming customer messages + delivery status here.         │
// │                                                                         │
// │  TWILIO SETUP:                                                          │
// │    Console → Messaging → WhatsApp → Sandbox Settings                    │
// │    Webhook URL:  https://<your-render-url>/api/webhook/whatsapp         │
// │    Status URL:   https://<your-render-url>/api/webhook/whatsapp/status  │
// │    Method: POST                                                         │
// │                                                                         │
// │  Supported customer keywords:                                           │
// │    hi/hello  → Welcome + menu  │  menu/services  → Service list         │
// │    book      → Booking link    │  status         → Latest appointment   │
// │    cancel    → Cancel info     │  hours          → Working hours        │
// │    location  → Address + map   │  (anything)     → Fallback menu        │
// └─────────────────────────────────────────────────────────────────────────┘

app.post("/api/webhook/whatsapp", async (req, res) => {
  const from         = req.body.From || "";             // "whatsapp:+919876543210"
  const body         = (req.body.Body || "").trim().toLowerCase();
  const customerName = req.body.ProfileName || "there";
  const phone        = from.replace("whatsapp:", "");

  console.log(`📩 WhatsApp from ${from}: "${body}"`);

  let reply = "";

  // ── Greeting ───────────────────────────────────────────────────────────
  if (["hi", "hello", "hey", "hii", "helo"].some(k => body.startsWith(k))) {
    reply =
      `👋 Hello ${customerName}! Welcome to *${SALON_NAME}*.\n\n` +
      `How can we help you today?\n\n` +
      `Reply with:\n` +
      `📋 *menu* — View our services\n` +
      `📅 *book* — Book an appointment\n` +
      `📍 *location* — Get our address\n` +
      `🕐 *hours* — Our working hours\n` +
      `❓ *status* — Check your appointment`;
  }

  // ── Service menu ───────────────────────────────────────────────────────
  else if (["menu", "services", "service", "list", "price", "pricing", "rate"].some(k => body.includes(k))) {
    try {
      const db       = engine.getDb();
      const snap     = await db.ref("services").orderByChild("is_active").equalTo(true).once("value");
      const services = snap.exists() ? snap.val() : {};

      // Group by category
      const grouped = {};
      Object.values(services).forEach(s => {
        if (!grouped[s.category]) grouped[s.category] = [];
        grouped[s.category].push(s);
      });

      reply = `📋 *${SALON_NAME} — Service Menu*\n\n`;
      for (const [cat, items] of Object.entries(grouped)) {
        reply += `*${cat.toUpperCase()}*\n`;
        items.forEach(s => { reply += `${s.icon} ${s.name} — ₹${s.price} (${s.duration_minutes} min)\n`; });
        reply += `\n`;
      }
      reply += `To book, reply *book* or visit our website! 👑`;
    } catch {
      reply = `📋 Our full service menu is available on our website.\nReply *book* to get the booking link!`;
    }
  }

  // ── Booking ────────────────────────────────────────────────────────────
  else if (["book", "appointment", "reserve", "slot"].some(k => body.includes(k))) {
    reply =
      `📅 *Book Your Appointment*\n\n` +
      `You can book instantly on our website:\n` +
      `🔗 https://prime-salon.onrender.com/booking\n\n` +
      `Or tell us:\n` +
      `1️⃣ Your preferred *service*\n` +
      `2️⃣ Preferred *date & time*\n` +
      `3️⃣ Preferred *stylist* (optional)\n\n` +
      `And we'll set it up for you! ✨`;
  }

  // ── Appointment status ─────────────────────────────────────────────────
  else if (["status", "check", "my appointment", "my booking"].some(k => body.includes(k))) {
    try {
      const db   = engine.getDb();
      const snap = await db.ref("appointments").orderByChild("customer_phone").equalTo(phone).limitToLast(1).once("value");
      if (snap.exists()) {
        const apt = Object.values(snap.val())[0];
        const displayDate = new Date(apt.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
        reply =
          `📋 *Your Latest Appointment*\n\n` +
          `💇 ${apt.service_name}\n🧑‍🎨 ${apt.stylist_name}\n` +
          `📅 ${displayDate} at ${apt.time_slot}\n📌 Status: *${apt.status.toUpperCase()}*\n\n` +
          `Need to reschedule? Just reply here! 📞`;
      } else {
        reply = `We couldn't find any recent appointments for your number.\nReply *book* to create a new appointment! 📅`;
      }
    } catch {
      reply = `Sorry, we couldn't check right now. Please call us at ${process.env.SALON_PHONE || "+911234567890"}.`;
    }
  }

  // ── Cancel / reschedule ────────────────────────────────────────────────
  else if (["cancel", "reschedule"].some(k => body.includes(k))) {
    reply =
      `To cancel or reschedule, please call us:\n📞 ${process.env.SALON_PHONE || "+911234567890"}\n\n` +
      `Our team will help you find a new slot right away! 🙏`;
  }

  // ── Working hours ──────────────────────────────────────────────────────
  else if (["hour", "timing", "time", "open", "close", "when"].some(k => body.includes(k))) {
    reply =
      `🕐 *Working Hours*\n\nMonday – Saturday: *10:00 AM – 9:00 PM*\nSunday: *Closed*\n\n` +
      `Walk-ins welcome! For guaranteed slots, reply *book*. 👑`;
  }

  // ── Location ───────────────────────────────────────────────────────────
  else if (["location", "address", "where", "direction", "map"].some(k => body.includes(k))) {
    reply =
      `📍 *${SALON_NAME}*\n${process.env.SALON_ADDRESS || "Model Town, Ludhiana, Punjab — 141002"}\n\n` +
      `🗺 Google Maps: https://maps.google.com/?q=Model+Town+Ludhiana\n\nSee you soon! 👑`;
  }

  // ── Thank you ──────────────────────────────────────────────────────────
  else if (["thank", "thanks", "thnx", "ty"].some(k => body.includes(k))) {
    reply = `You're welcome, ${customerName}! 😊 See you at ${SALON_NAME}! 👑`;
  }

  // ── Fallback ───────────────────────────────────────────────────────────
  else {
    reply =
      `Thanks for reaching out to *${SALON_NAME}*! 👑\n\n` +
      `I can help you with:\n📋 *menu* — Our services & prices\n📅 *book* — Book an appointment\n` +
      `📍 *location* — Our address\n🕐 *hours* — Working hours\n\n` +
      `Or call us directly: ${process.env.SALON_PHONE || "+911234567890"}`;
  }

  // Send reply via Twilio API
  if (reply) await whatsapp.sendRaw(phone, reply);

  // Return empty TwiML so Twilio doesn't send its own response
  res.set("Content-Type", "text/xml");
  res.status(200).send("<Response></Response>");
});

// ── Twilio delivery status callback ──────────────────────────────────────
// Twilio POSTs here when a message is queued / sent / delivered / read / failed.

app.post("/api/webhook/whatsapp/status", (req, res) => {
  const { MessageSid, MessageStatus, To, ErrorCode } = req.body;
  const emoji = { queued:"⏳", sent:"📤", delivered:"✅", read:"👀", failed:"❌", undelivered:"⚠️" }[MessageStatus] || "❓";
  console.log(`${emoji} WhatsApp ${MessageStatus}: ${MessageSid} → ${To}${ErrorCode ? ` (Error: ${ErrorCode})` : ""}`);
  res.status(200).send("OK");
});


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 7  ROUTES — ADMIN (Services CRUD, Stylists, Stats, Public)          │
// │                                                                         │
// │  Protected routes (require x-admin-pin header):                         │
// │    POST   /api/admin/verify-pin                                         │
// │    GET    /api/admin/services             List all services              │
// │    POST   /api/admin/services             Add a service                 │
// │    PATCH  /api/admin/services/:id         Update a service              │
// │    PATCH  /api/admin/services/:id/toggle  Toggle active/inactive        │
// │    DELETE /api/admin/services/:id         Delete a service              │
// │    GET    /api/admin/stylists             List all stylists             │
// │    PATCH  /api/admin/stylists/:id/toggle  Toggle availability           │
// │    PATCH  /api/admin/stylists/:id/days    Update working days           │
// │    GET    /api/admin/stats/:date          Revenue & booking stats       │
// │                                                                         │
// │  Public routes (no PIN):                                                │
// │    GET    /api/admin/services/public      Active services only          │
// │    GET    /api/admin/stylists/public      Available stylists only       │
// └─────────────────────────────────────────────────────────────────────────┘

function genId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Verify PIN (this IS the login — no middleware) ───────────────────────

app.post("/api/admin/verify-pin", (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ success: false, error: "PIN required" });
  res.json({ success: pin === ADMIN_PIN });
});

// ── Services CRUD ────────────────────────────────────────────────────────

app.get("/api/admin/services", requireAdmin, async (_req, res) => {
  try {
    const snap = await engine.getDb().ref("services").once("value");
    res.json({ success: true, services: snap.exists() ? snap.val() : {} });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/admin/services", requireAdmin, async (req, res) => {
  const { name, category, price, duration_minutes, description, icon } = req.body;
  if (!name || !category || !price || !duration_minutes) {
    return res.status(400).json({ success: false, error: "Required: name, category, price, duration_minutes" });
  }
  try {
    const id = genId("svc");
    const data = {
      name, category, price: Number(price), duration_minutes: Number(duration_minutes),
      description: description || "", icon: icon || "✂️",
      is_active: true, sort_order: Date.now(), created_at: Date.now(), updated_at: Date.now(),
    };
    await engine.getDb().ref(`services/${id}`).set(data);
    res.status(201).json({ success: true, id, service: data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch("/api/admin/services/:id", requireAdmin, async (req, res) => {
  try {
    const ref  = engine.getDb().ref(`services/${req.params.id}`);
    const snap = await ref.once("value");
    if (!snap.exists()) return res.status(404).json({ success: false, error: "Service not found" });

    const updates = { ...req.body, updated_at: Date.now() };
    delete updates.created_at; delete updates.id;
    if (updates.price) updates.price = Number(updates.price);
    if (updates.duration_minutes) updates.duration_minutes = Number(updates.duration_minutes);

    await ref.update(updates);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch("/api/admin/services/:id/toggle", requireAdmin, async (req, res) => {
  try {
    const ref  = engine.getDb().ref(`services/${req.params.id}/is_active`);
    const snap = await ref.once("value");
    if (!snap.exists()) return res.status(404).json({ success: false, error: "Service not found" });

    const newState = !snap.val();
    await engine.getDb().ref(`services/${req.params.id}`).update({ is_active: newState, updated_at: Date.now() });
    res.json({ success: true, is_active: newState });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete("/api/admin/services/:id", requireAdmin, async (req, res) => {
  try {
    const ref  = engine.getDb().ref(`services/${req.params.id}`);
    const snap = await ref.once("value");
    if (!snap.exists()) return res.status(404).json({ success: false, error: "Service not found" });
    await ref.remove();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Stylists ─────────────────────────────────────────────────────────────

app.get("/api/admin/stylists", requireAdmin, async (_req, res) => {
  try {
    const snap = await engine.getDb().ref("stylists").once("value");
    res.json({ success: true, stylists: snap.exists() ? snap.val() : {} });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch("/api/admin/stylists/:id/toggle", requireAdmin, async (req, res) => {
  try {
    const ref  = engine.getDb().ref(`stylists/${req.params.id}/is_available`);
    const snap = await ref.once("value");
    if (!snap.exists() && snap.val() === null) return res.status(404).json({ success: false, error: "Stylist not found" });

    const newState = !snap.val();
    await engine.getDb().ref(`stylists/${req.params.id}`).update({ is_available: newState });
    res.json({ success: true, is_available: newState });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch("/api/admin/stylists/:id/days", requireAdmin, async (req, res) => {
  const { working_days } = req.body;
  if (!Array.isArray(working_days)) {
    return res.status(400).json({ success: false, error: "working_days must be an array" });
  }
  try {
    await engine.getDb().ref(`stylists/${req.params.id}`).update({ working_days });
    res.json({ success: true, working_days });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Stats ────────────────────────────────────────────────────────────────

app.get("/api/admin/stats/:date", requireAdmin, async (req, res) => {
  try {
    const snap = await engine.getDb().ref("appointments").orderByChild("date").equalTo(req.params.date).once("value");
    const list = snap.exists() ? Object.values(snap.val()) : [];

    const stats = {
      total:      list.length,
      confirmed:  list.filter(a => a.status === "confirmed").length,
      pending:    list.filter(a => a.status === "pending").length,
      completed:  list.filter(a => a.status === "completed").length,
      cancelled:  list.filter(a => a.status === "cancelled").length,
      no_show:    list.filter(a => a.status === "no-show").length,
      revenue_expected:  list.filter(a => ["confirmed","completed"].includes(a.status)).reduce((s, a) => s + (a.price || 0), 0),
      revenue_completed: list.filter(a => a.status === "completed").reduce((s, a) => s + (a.price || 0), 0),
      online:     list.filter(a => a.source === "online").length,
      walk_in:    list.filter(a => a.source === "walk-in").length,
    };

    res.json({ success: true, date: req.params.date, stats });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Public endpoints (no PIN needed — customer frontend consumes these) ──

app.get("/api/admin/services/public", async (_req, res) => {
  try {
    const snap = await engine.getDb().ref("services").orderByChild("is_active").equalTo(true).once("value");
    res.json({ success: true, services: snap.exists() ? snap.val() : {} });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/admin/stylists/public", async (_req, res) => {
  try {
    const snap = await engine.getDb().ref("stylists").orderByChild("is_available").equalTo(true).once("value");
    res.json({ success: true, stylists: snap.exists() ? snap.val() : {} });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Serve the admin dashboard if built as static files
app.use(express.static("public"));


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 8  ERROR HANDLING                                                    │
// └─────────────────────────────────────────────────────────────────────────┘

// 404 — no route matched
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Route not found", path: req.originalUrl });
});

// Global error handler — catches unhandled throws in async route handlers
app.use((err, _req, res, _next) => {
  console.error("❌ Unhandled error:", err.stack || err.message);
  res.status(500).json({
    success: false,
    error: NODE_ENV === "production" ? "Internal server error" : err.message,
  });
});


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 9  CRON SCHEDULER                                                    │
// │                                                                         │
// │  Three automated jobs:                                                  │
// │    1. REMINDERS  — every 15 min (Mon-Sat 9AM-9PM IST)                   │
// │       Sends WhatsApp reminder ~2 hours before appointment               │
// │    2. LOCK CLEANUP — every 5 min                                        │
// │       Removes expired unconfirmed slot locks (abandoned bookings)        │
// │    3. NO-SHOW — daily at 9:30 PM IST                                    │
// │       Marks past confirmed appointments that weren't completed          │
// │                                                                         │
// │  NOTE: On Render's free tier the server sleeps after 15 min idle,       │
// │  which means cron jobs won't fire reliably. Upgrade to Starter ($7/mo)  │
// │  for always-on execution.                                               │
// └─────────────────────────────────────────────────────────────────────────┘

const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — matches firebaseEngine

/**
 * Parse "02:30 PM" → { hours: 14, minutes: 30 }
 */
function parseTime(timeStr) {
  const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const p = m[3].toUpperCase();
  if (p === "PM" && h !== 12) h += 12;
  if (p === "AM" && h === 12) h = 0;
  return { hours: h, minutes: min };
}

/** Get today's date as "YYYY-MM-DD" in IST */
function todayIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split("T")[0];
}

/** Get current { hours, minutes } in IST */
function nowIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return { hours: ist.getUTCHours(), minutes: ist.getUTCMinutes() };
}

// ── JOB 1: Send reminders ────────────────────────────────────────────────

async function runReminders() {
  const today = todayIST();
  const { hours: nowH, minutes: nowM } = nowIST();
  const nowTotal = nowH * 60 + nowM;

  console.log(`⏰ [Scheduler] Reminders — ${today} ${nowH}:${String(nowM).padStart(2,"0")} IST`);

  try {
    const snap = await engine.getDb().ref("appointments").orderByChild("date").equalTo(today).once("value");
    if (!snap.exists()) return;

    let sent = 0;
    for (const [id, apt] of Object.entries(snap.val())) {
      if (apt.status !== "confirmed" || apt.reminder_sent) continue;

      const parsed = parseTime(apt.time_slot);
      if (!parsed) continue;

      const aptTotal    = parsed.hours * 60 + parsed.minutes;
      const minutesUntil = aptTotal - nowTotal;

      // Send if appointment is 90–150 minutes away (~2 hours)
      if (minutesUntil >= 90 && minutesUntil <= 150) {
        console.log(`  📱 Reminder → ${apt.customer_name} for ${apt.time_slot}`);
        const result = await whatsapp.sendReminder(apt);
        await engine.getDb().ref(`appointments/${id}`).update({ reminder_sent: true });
        if (result.success) sent++;
      }
    }
    if (sent > 0) console.log(`  ✅ ${sent} reminders sent`);
  } catch (e) { console.error("❌ Reminder job error:", e.message); }
}

// ── JOB 2: Clean up expired locks ────────────────────────────────────────

async function runLockCleanup() {
  const today = todayIST();
  try {
    const snap = await engine.getDb().ref(`slot_locks/${today}`).once("value");
    if (!snap.exists()) return;

    let cleaned = 0;
    for (const [time, stylists] of Object.entries(snap.val())) {
      for (const [stylistId, lock] of Object.entries(stylists)) {
        if (lock.locked && !lock.confirmed && Date.now() - lock.locked_at > LOCK_TIMEOUT_MS) {
          await engine.getDb().ref(`slot_locks/${today}/${time}/${stylistId}`).remove();
          cleaned++;
        }
      }
    }
    if (cleaned > 0) console.log(`🧹 [Scheduler] Cleaned ${cleaned} expired locks`);
  } catch (e) { console.error("❌ Lock cleanup error:", e.message); }
}

// ── JOB 3: Auto no-show ─────────────────────────────────────────────────

async function runNoShowCheck() {
  const today = todayIST();
  const { hours: nowH, minutes: nowM } = nowIST();
  const nowTotal = nowH * 60 + nowM;

  try {
    const snap = await engine.getDb().ref("appointments").orderByChild("date").equalTo(today).once("value");
    if (!snap.exists()) return;

    let marked = 0;
    for (const [id, apt] of Object.entries(snap.val())) {
      if (apt.status !== "confirmed") continue;
      const parsed = parseTime(apt.time_slot);
      if (!parsed) continue;
      if (nowTotal - (parsed.hours * 60 + parsed.minutes) > 30) {
        await engine.getDb().ref(`appointments/${id}`).update({ status: "no-show", updated_at: Date.now() });
        marked++;
      }
    }
    if (marked > 0) console.log(`⚠️ [Scheduler] Marked ${marked} as no-show`);
  } catch (e) { console.error("❌ No-show check error:", e.message); }
}

// ── Start / Stop ─────────────────────────────────────────────────────────

let cronJobs = [];

function startScheduler() {
  console.log("⏰ Starting scheduler...");
  cronJobs.push(cron.schedule("*/15 9-21 * * 1-6", runReminders,   { timezone: "Asia/Kolkata" }));
  cronJobs.push(cron.schedule("*/5 * * * *",        runLockCleanup, { timezone: "Asia/Kolkata" }));
  cronJobs.push(cron.schedule("30 21 * * *",        runNoShowCheck, { timezone: "Asia/Kolkata" }));
  console.log("  ✅ Reminders   — every 15 min (Mon-Sat 9AM-9PM IST)");
  console.log("  ✅ Lock cleanup — every 5 min");
  console.log("  ✅ No-show     — daily 9:30 PM IST");
}

function stopScheduler() {
  cronJobs.forEach(j => j.stop());
  cronJobs = [];
  console.log("⏰ Scheduler stopped");
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 10  SERVER START & GRACEFUL SHUTDOWN                                 │
// └─────────────────────────────────────────────────────────────────────────┘

app.listen(PORT, () => {
  console.log("");
  console.log("═══════════════════════════════════════════════");
  console.log("  👑 PRIME SALON — Backend API Server");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Environment : ${NODE_ENV}`);
  console.log(`  Port        : ${PORT}`);
  console.log(`  Health      : http://localhost:${PORT}/api/health`);
  console.log(`  CORS        : ${corsOrigins.join(", ")}`);
  console.log("═══════════════════════════════════════════════");
  console.log("");

  startScheduler();
});

function shutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  stopScheduler();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("unhandledRejection", r => console.error("❌ Unhandled Rejection:", r));
process.on("uncaughtException",  e => { console.error("❌ Uncaught Exception:", e); shutdown("UNCAUGHT_EXCEPTION"); });
