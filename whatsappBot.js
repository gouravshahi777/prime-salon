// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  PRIME SALON — WhatsApp Bot (whatsappBot.js)                              ║
// ║                                                                           ║
// ║  Twilio-powered WhatsApp messaging with templated messages for:           ║
// ║    § 1  Twilio Client Setup & Phone Formatter                             ║
// ║    § 2  sendRaw         — Send any arbitrary WhatsApp message             ║
// ║    § 3  sendConfirmation — Booking confirmed notification                 ║
// ║    § 4  sendReminder    — 2-hour-before appointment reminder              ║
// ║    § 5  sendCancellation — Appointment cancelled notification             ║
// ║    § 6  sendThankYou    — Post-visit thank you message                    ║
// ║                                                                           ║
// ║  SETUP:                                                                   ║
// ║    1. Create account at https://twilio.com                                ║
// ║    2. Enable WhatsApp Sandbox (testing) or register Business number       ║
// ║    3. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM     ║
// ║       in your .env file                                                   ║
// ║                                                                           ║
// ║  For sandbox testing, each customer must first send                       ║
// ║  "join <your-sandbox-keyword>" to the Twilio sandbox number.              ║
// ║                                                                           ║
// ║  This module has ZERO dependency on Firebase — it only needs Twilio.      ║
// ║  firebaseEngine.js calls these functions after writing to the database.   ║
// ╚════════════════════════════════════════════════════════════════════════════╝

const twilio = require("twilio");


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 1  TWILIO CLIENT SETUP & PHONE FORMATTER                            │
// └─────────────────────────────────────────────────────────────────────────┘

let client = null;

/**
 * Lazily initialize the Twilio client.
 * Returns null if credentials aren't set (messages will be logged instead).
 */
function getClient() {
  if (!client) {
    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;

    if (!sid || !token) {
      console.warn("⚠️  Twilio credentials not set. WhatsApp messages will be logged but not sent.");
      return null;
    }

    client = twilio(sid, token);
  }
  return client;
}

// Convenience accessors for config
const FROM       = () => process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";
const SALON      = () => process.env.SALON_NAME           || "Prime Salon";
const SALON_ADDR = () => process.env.SALON_ADDRESS        || "Model Town, Ludhiana, Punjab — 141002";
const SALON_PH   = () => process.env.SALON_PHONE          || "+911234567890";


/**
 * Format any phone number into the "whatsapp:+91XXXXXXXXXX" format Twilio expects.
 *
 * Handles:
 *   "+919876543210"     → "whatsapp:+919876543210"
 *   "9876543210"        → "whatsapp:+919876543210"   (assumes India)
 *   "09876543210"       → "whatsapp:+919876543210"
 *   "whatsapp:+91..."   → returned as-is
 */
function formatWhatsAppNumber(phone) {
  let cleaned = phone.replace(/[\s\-()]/g, "");

  if (cleaned.startsWith("whatsapp:")) return cleaned;

  if (!cleaned.startsWith("+")) {
    if (cleaned.startsWith("0")) cleaned = cleaned.slice(1);
    if (cleaned.length === 10)   cleaned = "+91" + cleaned;
    else                         cleaned = "+" + cleaned;
  }

  return `whatsapp:${cleaned}`;
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 2  SEND RAW MESSAGE                                                  │
// │                                                                         │
// │  The core send function. All template functions below call this.         │
// │  If Twilio isn't configured, it logs the message to console instead     │
// │  (useful for local dev / testing without a Twilio account).             │
// └─────────────────────────────────────────────────────────────────────────┘

/**
 * Send a WhatsApp message to any number.
 *
 * @param {string} to   Customer phone (any format — gets normalized)
 * @param {string} body Message text (supports WhatsApp formatting: *bold*, _italic_)
 * @returns {Promise<{success: boolean, messageId: string, mock?: boolean}>}
 */
async function sendRaw(to, body) {
  const twilioClient = getClient();
  const formattedTo  = formatWhatsAppNumber(to);

  // ── Mock mode (no Twilio credentials) ──
  if (!twilioClient) {
    console.log(`📱 [WhatsApp Mock] To: ${formattedTo}`);
    console.log(`   Message: ${body.slice(0, 120)}${body.length > 120 ? "…" : ""}`);
    return { success: true, messageId: `mock_${Date.now()}`, mock: true };
  }

  // ── Live send via Twilio ──
  try {
    const message = await twilioClient.messages.create({
      from: FROM(),
      to: formattedTo,
      body,
    });

    console.log(`✅ WhatsApp sent to ${formattedTo} — SID: ${message.sid}`);
    return { success: true, messageId: message.sid };
  } catch (error) {
    console.error(`❌ WhatsApp failed to ${formattedTo}:`, error.message);
    return { success: false, error: error.message };
  }
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 3  BOOKING CONFIRMATION MESSAGE                                      │
// │                                                                         │
// │  Sent immediately after confirmBooking() in firebaseEngine.js.           │
// │  Contains full appointment details + salon address.                     │
// └─────────────────────────────────────────────────────────────────────────┘

async function sendConfirmation(appointment) {
  const { customer_name, customer_phone, service_name, stylist_name, date, time_slot, price } = appointment;

  const displayDate = new Date(date).toLocaleDateString("en-IN", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const message =
    `✨ *Booking Confirmed — ${SALON()}* ✨\n` +
    `\n` +
    `Hi ${customer_name}! Your appointment is confirmed:\n` +
    `\n` +
    `💇 *Service:* ${service_name}\n` +
    `🧑‍🎨 *Stylist:* ${stylist_name}\n` +
    `📅 *Date:* ${displayDate}\n` +
    `🕐 *Time:* ${time_slot}\n` +
    `💰 *Amount:* ₹${price.toLocaleString("en-IN")}\n` +
    `\n` +
    `📍 ${SALON_ADDR()}\n` +
    `\n` +
    `Please arrive 5 minutes early. To reschedule or cancel, ` +
    `reply to this message or call us at ${SALON_PH()}.\n` +
    `\n` +
    `See you soon! 👑`;

  return sendRaw(customer_phone, message);
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 4  APPOINTMENT REMINDER                                              │
// │                                                                         │
// │  Sent by the cron scheduler in server.js ~2 hours before the slot.      │
// │  Shorter and friendlier than the confirmation — just a nudge.           │
// └─────────────────────────────────────────────────────────────────────────┘

async function sendReminder(appointment) {
  const { customer_name, customer_phone, service_name, stylist_name, time_slot } = appointment;

  const message =
    `⏰ *Appointment Reminder — ${SALON()}*\n` +
    `\n` +
    `Hi ${customer_name}! Friendly reminder that your appointment is coming up:\n` +
    `\n` +
    `💇 ${service_name} with ${stylist_name}\n` +
    `🕐 Today at *${time_slot}*\n` +
    `\n` +
    `📍 ${SALON_ADDR()}\n` +
    `\n` +
    `We're looking forward to seeing you! 👑`;

  return sendRaw(customer_phone, message);
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 5  CANCELLATION NOTIFICATION                                         │
// │                                                                         │
// │  Sent when admin cancels an appointment or customer requests cancel.     │
// └─────────────────────────────────────────────────────────────────────────┘

async function sendCancellation(appointment) {
  const { customer_name, customer_phone, service_name, date, time_slot } = appointment;

  const displayDate = new Date(date).toLocaleDateString("en-IN", {
    weekday: "long", month: "long", day: "numeric",
  });

  const message =
    `❌ *Appointment Cancelled — ${SALON()}*\n` +
    `\n` +
    `Hi ${customer_name}, your appointment has been cancelled:\n` +
    `\n` +
    `💇 ${service_name}\n` +
    `📅 ${displayDate} at ${time_slot}\n` +
    `\n` +
    `To rebook, visit our website or message us anytime.\n` +
    `\n` +
    `📞 ${SALON_PH()}`;

  return sendRaw(customer_phone, message);
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  § 6  THANK YOU / POST-VISIT MESSAGE                                    │
// │                                                                         │
// │  Sent when admin marks appointment as "completed" in the dashboard.      │
// └─────────────────────────────────────────────────────────────────────────┘

async function sendThankYou(appointment) {
  const { customer_name, customer_phone, service_name } = appointment;

  const message =
    `🌟 *Thank You — ${SALON()}* 🌟\n` +
    `\n` +
    `Hi ${customer_name}! Thank you for choosing ${SALON()} ` +
    `for your ${service_name} today.\n` +
    `\n` +
    `We'd love to hear your feedback! ` +
    `Your satisfaction means the world to us. ❤️\n` +
    `\n` +
    `See you next time! 👑`;

  return sendRaw(customer_phone, message);
}


// ┌─────────────────────────────────────────────────────────────────────────┐
// │  EXPORTS                                                                │
// └─────────────────────────────────────────────────────────────────────────┘

module.exports = {
  sendRaw,
  sendConfirmation,
  sendReminder,
  sendCancellation,
  sendThankYou,
  formatWhatsAppNumber,
};
