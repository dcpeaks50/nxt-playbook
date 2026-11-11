// POST /hoops/import  body: { image?: { media_type, data (base64) }, text?: string, side?: "O" | "D" }
// Claude reads a play (a photo of a whiteboard / paper diagram, or the play typed out in words)
// and returns it in the basketball page's play format, ready to animate and touch up in the editor.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const DAILY_LIMIT = 60; // imports per day for the whole site (keeps the bill small if the link gets out)
const MAX_IMAGE_B64 = 7_000_000;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const IDS = ["O1", "O2", "O3", "O4", "O5", "X1", "X2", "X3", "X4", "X5"];

const point = { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["readable", "problem", "name", "side", "notes", "players", "ball", "steps"],
  properties: {
    readable: { type: "boolean", description: "false if this isn't a basketball play or can't be read" },
    problem: { type: "string", description: "when readable is false: a short, friendly reason for the coach; otherwise empty" },
    name: { type: "string" },
    side: { type: "string", enum: ["O", "D"] },
    notes: { type: "string" },
    players: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "x", "y"], properties: { id: { type: "string", enum: IDS }, x: { type: "number" }, y: { type: "number" } } } },
    ball: { type: "string", enum: IDS },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["say", "moves", "pass_to", "lob", "shot", "trap_by"],
        properties: {
          say: { type: "string" },
          moves: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "kind", "path"], properties: { id: { type: "string", enum: IDS }, kind: { type: "string", enum: ["cut", "drib", "screen", "slide"] }, path: { type: "array", items: point } } } },
          pass_to: { type: "string", enum: [...IDS, ""] },
          lob: { type: "boolean" },
          shot: { type: "boolean" },
          trap_by: { type: "array", items: { type: "string", enum: IDS } },
        },
      },
    },
  },
};

const SYSTEM = `You turn youth basketball plays into data for an app that animates them on a half court. The coach gives you a photo of a play (whiteboard, paper, clipboard, a screenshot of a playbook) and/or describes it in words.

Court coordinates are in feet. Picture the half court with the basket at the TOP of the picture:
- x runs left to right, from -25 (left sideline) to 25 (right sideline). x = 0 is the middle of the court.
- y runs from the baseline (y = 0, top) down to the half-court line (y = 47). Players can stand a little out of bounds (y down to -2 for an inbounder under the basket).
- The rim is at (0, 5.25). The lane (paint) is x -6 to 6, y 0 to 19. The free-throw line is y = 19; the top of the key / three-point arc is y = 25.
- Common spots: top (0, 26), right wing (16, 21), left wing (-16, 21), right corner (21, 4), left corner (-21, 4), right block (6, 7), left block (-6, 7), right elbow (6, 19), left elbow (-6, 19), high post (0, 18), short corner (±13, 4), half court (0, 45).
If the drawing has the basket at the bottom or on a side, rotate it so the basket is at the top, keeping the coach's left and right as they would see it from half court facing the basket.

Players: numbers 1-5 (usually in circles) are our offense, ids O1-O5. X's (X1-X5, or plain X marks) are defenders, ids X1-X5; number plain X's by where they stand if they have no numbers. Include defenders only if the play shows them or the coach mentions them. Positions in "players" are where everyone starts.

Line conventions: solid arrow = cut (kind "cut"); zig-zag / wavy line = dribble ("drib"); dashed or dotted line = pass; a line ending in a short perpendicular bar (a "T") = screen ("screen"). Defenders' movements are kind "slide". A curved line is a path with a bend point: give one or two points along it, ending at the end of the line.

Steps: break the play into moments, in order (follow numbers written on the lines if there are any; otherwise the natural order: screens before the cut off them, the cut before the pass to the cutter). Moves that happen at the same time go in the same step. Each step has at most one pass (pass_to = who catches it, or "" for none) OR one shot. The pass starts from whoever has the ball at that point. A final layup/shot is its own step with shot = true. Use lob = true for skip passes and lobs. trap_by lists the two defenders trapping the ball in that step (defense plays), else empty. Every path lists only the points AFTER the player's current spot, ending where he finishes.

"say": one short sentence per step in plain coach language a 10-year-old understands, like "1 passes to 2 on the wing." or "5 sets a screen for 1." "notes": 1-2 sentences of coaching points. "name": the play's name if it's written on the page, otherwise a short descriptive name. "side": "D" if the play teaches defense, else "O". "ball": who starts with the ball.

If the picture or text isn't a basketball play or you truly can't make it out, set readable to false and put a short, friendly reason in "problem" (fill the other fields with empty values). Otherwise readable = true and problem = "".`;

/** Claude's answer -> the page's play format ({ at, ball, beats: [{ say, m, pass, lob, shot, trap }] }). */
export function toPlay(r, side) {
  const at = {};
  for (const p of r.players) at[p.id] = [round(p.x, -25, 25), round(p.y, -3, 48)];
  if (!at[r.ball]) at[r.ball] = [0, 27];
  let holder = r.ball;
  const beats = r.steps.map((s) => {
    const b = { say: s.say || "", m: {} };
    for (const mv of s.moves) {
      if (!at[mv.id] || !mv.path.length) continue;
      const isX = mv.id[0] === "X";
      const k = isX ? "slide" : mv.kind === "slide" ? "cut" : mv.kind;
      b.m[mv.id] = { k, pts: mv.path.map((q) => [round(q.x, -25, 25), round(q.y, -3, 48)]) };
    }
    const by = s.trap_by.filter((id) => at[id]).slice(0, 2);
    if (by.length && holder) b.trap = { on: s.pass_to && at[s.pass_to] ? s.pass_to : holder, by };
    if (s.shot && holder) { b.shot = true; b.label = "SCORE!"; holder = null; }
    else if (s.pass_to && at[s.pass_to] && s.pass_to !== holder && holder) { b.pass = s.pass_to; if (s.lob) b.lob = true; if (s.pass_to[0] === "X") b.label = "STEAL!"; holder = s.pass_to; }
    if (!b.label && b.trap) b.label = "TRAP!";
    return b;
  }).filter((b) => Object.keys(b.m).length || b.pass || b.shot || b.trap);
  if (!beats.length) beats.push({ say: "", m: {} });
  return { name: r.name || "Imported play", side: r.side === "D" ? "D" : "O", notes: r.notes || "", ball: r.ball, at, beats };
}
const round = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, Number(v) || 0)) * 2) / 2;

export async function importPlay(req, env, json) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Play import isn't switched on yet (the server needs its Claude key)." }, 503);
  let body; try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  const text = String(body?.text || "").slice(0, 4000).trim(), img = body?.image;
  if (!text && !img) return json({ error: "Add a photo of the play or describe it." }, 400);
  if (img && (!IMAGE_TYPES.includes(img.media_type) || typeof img.data !== "string" || img.data.length > MAX_IMAGE_B64)) return json({ error: "That photo is too big or isn't a picture. Try a smaller photo." }, 400);

  // daily cap for the whole site
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS hoops_imports (day TEXT PRIMARY KEY, n INTEGER NOT NULL)").run();
  const day = new Date().toISOString().slice(0, 10);
  const used = (await env.DB.prepare("SELECT n FROM hoops_imports WHERE day = ?").bind(day).first())?.n || 0;
  if (used >= DAILY_LIMIT) return json({ error: `That's the limit of ${DAILY_LIMIT} imports for today. Try again tomorrow.` }, 429);
  await env.DB.prepare("INSERT INTO hoops_imports (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1").bind(day).run();

  const content = [];
  if (img) content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
  content.push({ type: "text", text: (text ? `The coach says: ${text}\n\n` : "") + `Turn this into the play data.${body?.side === "D" ? " The coach is looking at defense plays." : ""}` });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal") return json({ error: "Claude couldn't read that one. Try a clearer photo or describe the play in words." }, 422);
    if (res.stop_reason === "max_tokens") return json({ error: "That play is too long to read in one go. Try splitting it into two plays." }, 422);
    const out = res.content.find((b) => b.type === "text")?.text;
    const r = JSON.parse(out || "{}");
    if (!r.readable) return json({ error: r.problem || "Couldn't read a basketball play in that." }, 422);
    return json({ play: toPlay(r, body?.side) });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Claude is busy right now. Try again in a minute." }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "The server's Claude key isn't working." }, 503);
    if (err instanceof Anthropic.APIError) return json({ error: `Claude had a problem (${err.status}). Try again.` }, 502);
    if (err instanceof SyntaxError) return json({ error: "Claude's answer came back garbled. Try again." }, 502);
    return json({ error: "Couldn't reach Claude. Try again." }, 502);
  }
}
