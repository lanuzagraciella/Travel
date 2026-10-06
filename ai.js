/* AI photo coach: send an inspiration photo to Claude and get step-by-step
 * directions for recreating it with a phone camera.
 *
 * The app has no server, so it calls the Claude API straight from the
 * browser with the user's own API key (saved only in this browser). */
(() => {
  "use strict";

  const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm";
  const MODEL = "claude-opus-5-5";

  const list = { type: "array", items: { type: "string" } };
  const GUIDE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "shot_type", "camera", "composition", "lighting", "pose", "photographer_steps", "edit_tips", "pro_tip"],
    properties: {
      summary: { type: "string" },
      shot_type: { type: "string" },
      camera: {
        type: "object",
        additionalProperties: false,
        required: ["lens", "orientation", "mode", "height", "angle", "distance", "settings"],
        properties: {
          lens: { type: "string" },
          orientation: { type: "string" },
          mode: { type: "string" },
          height: { type: "string" },
          angle: { type: "string" },
          distance: { type: "string" },
          settings: list,
        },
      },
      composition: list,
      lighting: { type: "string" },
      pose: list,
      photographer_steps: list,
      edit_tips: list,
      pro_tip: { type: "string" },
    },
  };

  const SYSTEM = `You are a friendly travel photographer who coaches people to recreate photos they have seen online, using only a phone camera.

Study the inspiration photo and explain exactly how to take it again. Be concrete and practical:
- Lens: name the phone zoom button to use (0.5x ultra-wide, 1x main, 2x, 3x or 5x telephoto) and why. Long-lens looks (compressed background, big landmark behind a person) usually mean stepping back and zooming in.
- Camera height and angle: e.g. "phone at knee height, tilted slightly up", "chest height, level".
- Distance between photographer and subject, and between subject and background.
- Orientation (portrait or landscape) and camera mode (Photo, Portrait, Live, burst, timer, 0.5x).
- Phone settings: turn on the grid, tap to focus on the face, slide exposure down for bright skies, lock focus and exposure (AE/AF lock), use the volume button or a timer for steadiness.
- Composition: where the subject sits on the rule-of-thirds grid, leading lines, symmetry, how much sky.
- Lighting: time of day and direction of light as it appears in the photo.
- Pose: body position, hands, where to look, how to move, written for the person being photographed.
- Photographer steps: a short ordered checklist the friend holding the phone can follow on the spot.
- Edit tips: simple edits in the phone's photo app or a free editor to match the look.

Describe poses and outfits generally. Never try to identify who the person in the photo is.
Keep every item short enough to read at a glance while standing at the spot.`;

  // Shrink large photos before sending (the API downsizes anything bigger
  // anyway); this keeps uploads fast on mobile data.
  async function toJpegBase64(blob, maxSide = 1568) {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  }

  let clientPromise = null;
  let clientKey = null;
  async function getClient(apiKey) {
    if (!clientPromise || clientKey !== apiKey) {
      clientKey = apiKey;
      clientPromise = import(SDK_URL).then(({ default: Anthropic }) =>
        new Anthropic({ apiKey, dangerouslyAllowBrowser: true }));
    }
    return clientPromise;
  }

  async function photoGuide({ apiKey, blob, spotName, cityName, bestTime }) {
    if (!apiKey) throw new Error("Add your Claude API key in Settings (⚙) to use the AI photo coach.");
    const [client, data] = await Promise.all([getClient(apiKey), toJpegBase64(blob)]);

    const context = [
      spotName && `Location: ${spotName}${cityName ? `, ${cityName}` : ""}.`,
      bestTime && `Local tip for this spot: ${bestTime}.`,
      "How do I recreate this photo with my phone?",
    ].filter(Boolean).join("\n");

    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: GUIDE_SCHEMA } },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
          { type: "text", text: context },
        ],
      }],
    });

    let msg;
    try {
      msg = await stream.finalMessage();
    } catch (err) {
      if (err?.status === 401) throw new Error("Your Claude API key was rejected. Check it in Settings (⚙).");
      if (err?.status === 429) throw new Error("Too many requests right now. Wait a moment and try again.");
      throw new Error(err?.message || "The AI photo coach is unavailable right now.");
    }
    if (msg.stop_reason === "refusal") throw new Error("Claude couldn't help with this photo. Try a different one.");
    if (msg.stop_reason === "max_tokens") throw new Error("The answer was cut off. Please try again.");
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Got an unexpected answer. Please try again.");
    }
  }

  window.WPAI = { photoGuide };
})();
