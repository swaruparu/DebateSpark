// Netlify Function: keeps the Gemini API key on the server.
// Set GEMINI_API_KEY in Netlify > Site configuration > Environment variables.

const FORMATS = ["Lincoln-Douglas", "Public Forum", "MSPDP"];
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Only students with a real PIN may use the coach. PINs are checked against Firestore
// (pinLookup allows single-document reads) and remembered for 5 minutes per function instance.
const okPins = new Map();
async function validPin(pin) {
  if (!/^\d{6,12}$/.test(pin)) return false;
  const hit = okPins.get(pin);
  if (hit && Date.now() - hit < 300000) return true;
  const project = Netlify.env.get("FIREBASE_PROJECT_ID") || "debate-spark-4cec6";
  try {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/pinLookup/${pin}`);
    if (r.ok) { okPins.set(pin, Date.now()); return true; }
  } catch {}
  return false;
}

function skillPrompt(format, topic) {
  return `You are a debate coach helping a middle school student practice for a ${format} debate on the topic: "${topic}".
Adapt your feedback to the norms of ${format} (LD emphasizes values/criteria, PF emphasizes practical impact, MSPDP emphasizes cross-examination and team dynamics).
Your role each turn: respond as an engaged opponent or coach. You may give a brief EXAMPLE of what a counter-argument could sound like to illustrate a technique, but never write a full ready-to-use speech or argument the student could copy as their own homework. Ask probing questions that expose weak points. Point out logical gaps, missing evidence, or structural issues as they come up.
Tone: encouraging but honest — never harsh, never inflate praise.
Keep responses to 2-4 sentences, appropriate for a middle schooler.
Never write the student's argument or speech for them.`;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = Netlify.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "Server key not configured" }, 500);

  let b;
  try { b = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  if (!(await validPin(String(b.pin || "")))) return json({ error: "Invalid PIN" }, 401);
  if (Array.isArray(b.history) && b.history.length > 40) return json({ error: "Session too long" }, 400);

  const format = FORMATS.includes(b.format) ? b.format : "Public Forum";
  const topic = String(b.topic || "").slice(0, 300);
  const grading = !!b.grading;
  const userText = b.userText ? String(b.userText).slice(0, 2000) : null;

  const contents = (Array.isArray(b.history) ? b.history : []).slice(-24).map((h) => ({
    role: h.role === "model" ? "model" : "user",
    parts: [{ text: String(h.text || "").slice(0, 2000) }],
  }));
  if (userText) contents.push({ role: "user", parts: [{ text: userText }] });
  if (grading) contents.push({ role: "user", parts: [{ text: "Please grade this session now, following the format given." }] });
  if (contents.length === 0) return json({ error: "Nothing to send" }, 400);

  const system = grading
    ? skillPrompt(format, topic) +
      `\n\nThe practice session is over. Grade the student's overall performance on a letter scale (A-F), based on evidence, logic, structure, and delivery, weighted appropriately for ${format}. Give 2-3 sentences of reasoning per criterion, in encouraging but honest, age-appropriate language. Format your reply EXACTLY as:\nGRADE: <letter>\nEvidence: <text>\nLogic: <text>\nStructure: <text>\nDelivery: <text>`
    : skillPrompt(format, topic);

  const model = Netlify.env.get("GEMINI_MODEL") || "gemini-3.5-flash-lite";
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents }),
      }
    );
    const data = await res.json();
    if (!res.ok) return json({ error: data.error?.message || "Gemini error" }, res.status);
    return json({ text: data.candidates?.[0]?.content?.parts?.[0]?.text || "" });
  } catch (err) {
    return json({ error: "Upstream request failed" }, 502);
  }
};

// Netlify rate limit: at most 120 requests per minute per IP (a classroom often shares one IP).
export const config = {
  path: "/api/gemini",
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
